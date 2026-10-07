#!/usr/bin/env python3
"""
OCR specific pages of a PDF and overlay invisible searchable text.
Optionally dewarp+clean other pages (from PDF sources) without OCR.

Used by the Replace Pages pipeline to add OCR to replaced/inserted pages
so the final PDF remains fully searchable. Pages sourced from PDFs get
dewarp+clean instead of OCR (they already have text).

Usage:
  python replace_ocr.py <input> <output> <progress_file> <ocr_pages_csv> [fix_pages_csv]

  ocr_pages_csv:  comma-separated 1-based page numbers to OCR, e.g. "1,3,5"
  fix_pages_csv:  comma-separated 1-based page numbers to dewarp+clean (no OCR)

Progress is written to <progress_file> as JSON:
  {"phase": "ocr", "current": 3, "total": 5}
"""

import sys
import os
import gc
import json
import multiprocessing
import shutil
import traceback

import numpy as np
import cv2

# Add scripts directory to path so we can import sibling modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import fitz  # pymupdf
except ImportError:
    print("Error: pymupdf required. Install: pip install pymupdf", file=sys.stderr)
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────
RENDER_DPI = 200


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Cancel helper ────────────────────────────────────────────────────

def _is_cancelled(cancel_path):
    """Check if the cancel sentinel file exists."""
    return os.path.isfile(cancel_path)


# ── OCR worker ───────────────────────────────────────────────────────

def _ocr_worker(args):
    """
    Worker: render one page, convert to grayscale, run OCR.
    Returns (page_num_1based, ocr_result_dict) or (page_num, None) on failure.
    """
    (input_path, page_idx, total, cancel_path, ocr_out_dir) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (pnum, None)

    try:
        import fitz as _fitz
        doc = _fitz.open(input_path)
        page = doc[page_idx]
        pix = page.get_pixmap(dpi=RENDER_DPI)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.h, pix.w, pix.n).copy()
        n_ch = pix.n
        del pix
        doc.close()

        if n_ch == 4:
            gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
        elif n_ch == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            gray = img.copy()
        del img

        if _is_cancelled(cancel_path):
            del gray
            return (pnum, None)

        from ocr import ocr_page
        result = ocr_page(gray, page_num=pnum, render_dpi=RENDER_DPI)
        del gray

        # Write per-page JSON (crash-safe partial results)
        page_json = os.path.join(ocr_out_dir, f'page_{pnum:04d}.json')
        with open(page_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

        gc.collect()
        return (pnum, result)

    except Exception as exc:
        print(f"[replace-ocr] Page {pnum} OCR failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (pnum, None)


# ── Fix worker (dewarp + clean) ──────────────────────────────────────

JPEG_QUALITY = 92

def _fix_worker(args):
    """
    Worker: render one page, straighten, dewarp, clean, return JPEG bytes.
    Returns (page_num_1based, jpeg_bytes_or_None, (rect_w, rect_h))
    """
    (input_path, page_idx, total, cancel_path) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (pnum, None, (0, 0))

    try:
        import fitz as _fitz
        from clean_pdf import dewarp_page, clean_page
        from straighten_pdf import (detect_skew_from_text, straighten_page,
                                    MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE,
                                    DETECT_WIDTH)

        doc = _fitz.open(input_path)
        page = doc[page_idx]
        rect_w = page.rect.width
        rect_h = page.rect.height

        pix = page.get_pixmap(dpi=RENDER_DPI)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.h, pix.w, pix.n).copy()
        n_ch = pix.n
        del pix
        doc.close()

        if n_ch == 4:
            gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
        elif n_ch == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            gray = img.copy()
        del img

        # Straighten (deskew) — detect at reduced resolution, rotate at full
        fh, fw = gray.shape
        det_scale = DETECT_WIDTH / fw
        det_h = int(fh * det_scale)
        small = cv2.resize(gray, (DETECT_WIDTH, det_h),
                           interpolation=cv2.INTER_AREA)
        angle, confidence = detect_skew_from_text(small)
        del small

        was_straightened = False
        if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
            gray = straighten_page(gray, angle)
            was_straightened = True
            print(f"[replace-fix] Page {pnum}/{total}: "
                  f"straightened by {angle:.2f}\u00b0", file=sys.stderr)

        # Dewarp
        dewarped, was_dewarped = dewarp_page(gray)
        del gray
        print(f"[replace-fix] Page {pnum}/{total}: "
              f"straightened={was_straightened} dewarped={was_dewarped}",
              file=sys.stderr)

        # Clean
        cleaned = clean_page(dewarped)
        del dewarped
        print(f"[replace-fix] Page {pnum}/{total}: cleaned", file=sys.stderr)

        _, jpeg_buf = cv2.imencode('.jpg', cleaned,
                                    [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        del cleaned
        gc.collect()
        return (pnum, jpeg_buf.tobytes(), (rect_w, rect_h))

    except Exception as exc:
        print(f"[replace-fix] Page {pnum} fix failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (pnum, None, (0, 0))


# ── Searchable PDF overlay ───────────────────────────────────────────

def _build_searchable_pdf(output_path, ocr_results, ocr_page_set):
    """Overlay invisible OCR text on specific pages of the output PDF."""
    doc = fitz.open(output_path)
    font = fitz.Font('helv')
    words_added = 0

    for page_data in ocr_results:
        pnum = page_data['page']
        if pnum not in ocr_page_set:
            continue
        page_idx = pnum - 1
        if page_idx >= len(doc):
            continue
        if page_data.get('error'):
            continue

        page = doc[page_idx]
        pw = page.rect.width   # PDF points
        ph = page.rect.height
        iw = page_data['width']   # OCR pixel dimensions
        ih = page_data['height']
        if iw == 0 or ih == 0:
            continue
        sx = pw / iw  # pixel → points scale
        sy = ph / ih

        tw = fitz.TextWriter(page.rect)

        for block in page_data.get('blocks', []):
            for line in block.get('lines', []):
                for word in line.get('words', []):
                    txt = word.get('text', '').strip()
                    if not txt:
                        continue
                    bx, by, bw, bh = word['bbox']
                    w_pt = bw * sx
                    h_pt = bh * sy
                    if w_pt < 1 or h_pt < 1:
                        continue

                    # Scale font so rendered width matches bbox width
                    fs = h_pt * 0.9
                    tl = font.text_length(txt, fontsize=fs)
                    if tl > 0:
                        fs = fs * (w_pt / tl)
                        fs = max(1.0, min(fs, h_pt))

                    x0 = bx * sx
                    baseline_y = by * sy + h_pt * 0.85

                    try:
                        tw.append(fitz.Point(x0, baseline_y), txt,
                                  fontsize=fs, font=font)
                        words_added += 1
                    except Exception:
                        pass

        tw.write_text(page, render_mode=3, color=(0, 0, 0))

    # Atomic save via temp file
    tmp_out = output_path + '.tmp'
    doc.save(tmp_out, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp_out, output_path)
    print(f"[replace-ocr] Searchable PDF: {words_added} words embedded",
          file=sys.stderr)


# ── Main ─────────────────────────────────────────────────────────────

def _num_workers():
    n = os.cpu_count() or 2
    return max(2, min(n, 4))


def _run_fix_phase(input_path, output_path, fix_page_set, total_pages,
                    progress_file, cancel_path):
    """Dewarp + clean specific pages and replace them in the output PDF."""
    fix_count = len(fix_page_set)
    if fix_count == 0:
        return

    n_workers = _num_workers()
    write_progress(progress_file, 'fixing', 0, fix_count)
    print(f"[replace-fix] Starting dewarp+clean on {fix_count} pages "
          f"({n_workers} workers)", file=sys.stderr)

    ctx = multiprocessing.get_context('spawn')
    pool = ctx.Pool(n_workers)

    tasks = [
        (input_path, pnum - 1, total_pages, cancel_path)
        for pnum in sorted(fix_page_set)
    ]

    completed = 0

    try:
        results = []
        for pnum, jpeg_bytes, rect_wh in pool.imap(_fix_worker, tasks):
            if _is_cancelled(cancel_path):
                print("[replace-fix] Cancelled, terminating pool",
                      file=sys.stderr)
                pool.terminate()
                pool.join()
                sys.exit(0)

            completed += 1
            write_progress(progress_file, 'fixing', completed, fix_count)

            if jpeg_bytes is not None:
                results.append((pnum, jpeg_bytes, rect_wh))
                print(f"[replace-fix] Page {pnum}/{total_pages}: done",
                      file=sys.stderr)
            else:
                print(f"[replace-fix] Page {pnum}/{total_pages}: "
                      f"FAILED (kept original)", file=sys.stderr)
    except Exception as exc:
        print(f"[replace-fix] Pool error: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        pool.terminate()
        pool.join()
        raise
    else:
        pool.close()
        pool.join()

    # Replace fixed pages in the output PDF
    if results:
        write_progress(progress_file, 'saving', 0, 0)
        doc = fitz.open(output_path)
        for pnum, jpeg_bytes, (rect_w, rect_h) in results:
            page_idx = pnum - 1
            if page_idx >= len(doc):
                continue
            page = doc[page_idx]
            w = page.rect.width
            h = page.rect.height
            # Delete and re-create page with fixed image
            doc.delete_page(page_idx)
            new_page = doc.new_page(page_idx, width=w, height=h)
            new_page.insert_image(fitz.Rect(0, 0, w, h), stream=jpeg_bytes)
            del jpeg_bytes

        tmp_out = output_path + '.fix_tmp'
        doc.save(tmp_out, garbage=3, deflate=True)
        doc.close()
        os.replace(tmp_out, output_path)
        print(f"[replace-fix] Replaced {len(results)} pages with fixed versions",
              file=sys.stderr)

    gc.collect()


def main():
    if len(sys.argv) < 5:
        print("Usage: python replace_ocr.py <input> <output> <progress_file> "
              "<ocr_pages_csv> [fix_pages_csv]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    progress_file = sys.argv[3]
    ocr_pages_csv = sys.argv[4]
    fix_pages_csv = sys.argv[5] if len(sys.argv) > 5 else ''

    # Parse OCR page numbers (1-based)
    ocr_page_set = set()
    for tok in ocr_pages_csv.split(','):
        tok = tok.strip()
        if tok.isdigit():
            ocr_page_set.add(int(tok))

    # Parse fix page numbers (1-based) — dewarp+clean, no OCR
    fix_page_set = set()
    for tok in fix_pages_csv.split(','):
        tok = tok.strip()
        if tok.isdigit():
            fix_page_set.add(int(tok))

    if not ocr_page_set and not fix_page_set:
        print("[replace-ocr] No valid page numbers to process", file=sys.stderr)
        sys.exit(1)

    tmp_dir = os.path.dirname(os.path.abspath(output_path))
    cancel_path = os.path.join(tmp_dir, '_cancel')

    try:
        # Copy input to output (we'll modify output in-place)
        shutil.copy2(input_path, output_path)

        doc = fitz.open(input_path)
        total_pages = len(doc)
        doc.close()

        # Filter to only pages that actually exist
        ocr_page_set = {p for p in ocr_page_set if 1 <= p <= total_pages}
        fix_page_set = {p for p in fix_page_set if 1 <= p <= total_pages}
        ocr_count = len(ocr_page_set)
        fix_count = len(fix_page_set)

        if ocr_count == 0 and fix_count == 0:
            write_progress(progress_file, 'done', 0, 0)
            return

        # --- Phase 1: Dewarp + clean fix pages ---
        if fix_count > 0:
            _run_fix_phase(input_path, output_path, fix_page_set,
                           total_pages, progress_file, cancel_path)

            if _is_cancelled(cancel_path):
                sys.exit(0)

        # --- Phase 2: OCR ---
        if ocr_count > 0:
            n_workers = _num_workers()
            write_progress(progress_file, 'ocr', 0, ocr_count)
            print(f"[replace-ocr] Starting OCR on {ocr_count} pages "
                  f"({n_workers} workers)", file=sys.stderr)

            ocr_out_dir = os.path.join(tmp_dir, 'ocr')
            os.makedirs(ocr_out_dir, exist_ok=True)

            ctx = multiprocessing.get_context('spawn')
            pool = ctx.Pool(n_workers)

            # OCR reads from output_path so fix-phase changes (dewarp/clean)
            # are visible to the OCR workers
            ocr_source = output_path
            tasks = [
                (ocr_source, pnum - 1, total_pages, cancel_path, ocr_out_dir)
                for pnum in sorted(ocr_page_set)
            ]

            completed = 0
            succeeded = 0
            all_results = []

            try:
                for pnum, result in pool.imap_unordered(_ocr_worker, tasks):
                    if _is_cancelled(cancel_path):
                        print("[replace-ocr] Cancelled, terminating pool",
                              file=sys.stderr)
                        pool.terminate()
                        pool.join()
                        sys.exit(0)

                    completed += 1
                    write_progress(progress_file, 'ocr', completed, ocr_count)

                    if result is not None:
                        succeeded += 1
                        all_results.append(result)
                        conf = result.get('mean_conf', 0)
                        words = sum(
                            len(l.get('words', []))
                            for b in result.get('blocks', [])
                            for l in b.get('lines', [])
                        )
                        print(f"[replace-ocr] Page {pnum}/{total_pages}: "
                              f"conf={conf:.1f} words={words}", file=sys.stderr)
                    else:
                        print(f"[replace-ocr] Page {pnum}/{total_pages}: "
                              f"FAILED (skipped)", file=sys.stderr)
            except Exception as exc:
                print(f"[replace-ocr] Pool error: {exc}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                pool.terminate()
                pool.join()
                raise
            else:
                pool.close()
                pool.join()

            print(f"[replace-ocr] OCR done. {succeeded}/{ocr_count} pages succeeded.",
                  file=sys.stderr)

            # Build searchable PDF overlay
            if all_results:
                write_progress(progress_file, 'saving', 0, 0)
                _build_searchable_pdf(output_path, all_results, ocr_page_set)

        write_progress(progress_file, 'done', total_pages, total_pages)

    except SystemExit:
        raise
    except Exception as e:
        print(f"[replace-ocr] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(progress_file, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e),
                       'current': 0, 'total': 0}, f)
        sys.exit(1)


if __name__ == '__main__':
    main()
