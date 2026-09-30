#!/usr/bin/env python3
"""
Full Book Fix PDF processing pipeline (server-side).

Combines straightening, dewarping, cleaning, and OCR in a single pass.
For each page:
  1. Render at target DPI via pymupdf
  2. (if straighten) Detect skew via text line analysis, rotate to fix
  3. (if dewarp) Dewarp curved text lines
  4. (if clean) Clean background/bleed-through
  5. Add to output PDF
  6. (if ocr) Run Tesseract OCR in parallel after processing

Usage:
  python fullfix_pdf.py <input> <output> <progress_file> <book_name> \
    <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1] [skip_clean:1,3,5] [ocr:0|1] \
    [skip_straighten:1,3,5] [skip_dewarp:1,3,5]

Progress is written to <progress_file> as JSON after each page:
  {"phase": "fixing", "current": 5, "total": 50}
"""

import sys
import os
import gc
import json
import multiprocessing
import shutil
import tempfile
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
JPEG_QUALITY = 92
BATCH_SIZE = 20  # pages per batch before flushing to disk


def is_color_page(rgb: np.ndarray) -> bool:
    """True for pages that really contain colour (covers, illustrations,
    photos), False for text pages, including photos/scans of text pages with
    a colour cast (bluish lamp, yellowed paper). The old test (mean
    saturation > 20) called tinted text pages "colour" and skipped them.

    1. Paper colour = median of the brightest 30 % of pixels. If it is only a
       tint (its own saturation < 100, about 40 %), divide it out (white balance), so a
       bluish/yellowish page becomes neutral. A cover whose "paper" is itself
       strongly coloured is colour.
    2. After that, colour = mean saturation > 20, or > 3 % of the pixels
       clearly saturated (> 60): an illustration or photo. A small stamp or
       a highlighted word stays below that.
    """
    rgb = rgb[:, :, :3]
    small = cv2.resize(rgb, (400, int(400 * rgb.shape[0] / rgb.shape[1])), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)
    v = hsv[:, :, 2]
    bright = v >= np.percentile(v, 70)
    paper = np.median(small[bright].reshape(-1, 3), axis=0).astype(np.float32)
    paper_sat = cv2.cvtColor(paper.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2HSV)[0, 0, 1]
    if paper_sat >= 100:
        return True
    wb = small.astype(np.float32) * (paper.mean() / np.maximum(paper, 1))
    s = cv2.cvtColor(np.clip(wb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2HSV)[:, :, 1]
    return bool(s.mean() > 20 or (s > 60).mean() > 0.03)


def _num_workers():
    """Auto-detect worker count: min(cpu_count, 4), floor of 2."""
    n = os.cpu_count() or 2
    return max(2, min(n, 4))


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Incremental merge ────────────────────────────────────────────────

def _merge_batches(batch_files, output_path, metadata):
    """Merge batch PDFs into output one at a time to cap memory usage."""
    if len(batch_files) == 1:
        # Single batch — just rename and set metadata
        doc = fitz.open(batch_files[0])
        doc.set_metadata(metadata)
        doc.save(output_path, deflate=True, garbage=3)
        doc.close()
        os.remove(batch_files[0])
        return

    # Start with first batch as the accumulator on disk
    os.rename(batch_files[0], output_path)

    for bf in batch_files[1:]:
        acc = fitz.open(output_path)
        batch = fitz.open(bf)
        acc.insert_pdf(batch)
        batch.close()
        os.remove(bf)
        acc.save(output_path, incremental=True, encryption=0)
        acc.close()
        gc.collect()

    # Set metadata on final file
    final = fitz.open(output_path)
    final.set_metadata(metadata)
    final.save(output_path, incremental=True, encryption=0)
    final.close()


# ── Cancel helper ────────────────────────────────────────────────────

def _is_cancelled(cancel_path):
    """Check if the cancel sentinel file exists."""
    return os.path.isfile(cancel_path)


# ── Fix worker (module-level for multiprocessing pickling) ───────────

def _fix_worker(args):
    """
    Worker function for parallel page fixing.

    Opens the input PDF, renders one page, runs v2/straighten/dewarp/clean,
    optionally saves pre-clean gray image for OCR reuse.

    Returns (page_idx, jpeg_bytes_or_None, (rect_width, rect_height)).
    """
    (input_path, page_idx, total, do_straighten, do_clean, do_dewarp,
     do_v2, skip_clean_list, cancel_path, gray_dir,
     skip_straighten_list, skip_dewarp_list) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (page_idx, None, (0, 0))

    try:
        import fitz as _fitz
        doc = _fitz.open(input_path)
        page = doc[page_idx]
        rect_w = page.rect.width
        rect_h = page.rect.height

        pix = page.get_pixmap(dpi=RENDER_DPI)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.h, pix.w, pix.n).copy()
        n_channels = pix.n
        del pix
        doc.close()

        # Detect color pages (covers, illustrations)
        is_color = False
        if (do_clean or do_dewarp or do_v2) and n_channels >= 3:
            is_color = is_color_page(img[:, :, :3])

        if n_channels == 4:
            gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
        elif n_channels == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            gray = img.copy()
        del img

        modified = False
        result = gray

        # --- V2 Pipeline (replaces straighten + dewarp when enabled) ---
        skip_v2 = skip_straighten_list and pnum in skip_straighten_list
        if do_v2 and not is_color and not skip_v2:
            from scanner.scan_page import process_page_v2
            result = process_page_v2(result, pnum, total)
            modified = True
        elif do_v2 and skip_v2:
            print(f"[fullfix] Page {pnum}/{total}: skipped v2 (user excluded)",
                  file=sys.stderr)

        if not do_v2 or is_color or skip_v2:
            # --- Step 1: Straighten (legacy) ---
            skip_str = skip_straighten_list and pnum in skip_straighten_list
            if do_straighten and not skip_str:
                from straighten_pdf import detect_skew_from_text, straighten_page
                from straighten_pdf import DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE
                h, w = result.shape
                scale = DETECT_WIDTH / w
                dh = int(h * scale)
                small = cv2.resize(result, (DETECT_WIDTH, dh),
                                   interpolation=cv2.INTER_AREA)
                angle, confidence = detect_skew_from_text(small)
                del small

                if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                    result = straighten_page(result, angle)
                    modified = True
                    print(f"[fullfix] Page {pnum}/{total}: straightened {angle:.2f}\u00b0 "
                          f"conf={confidence:.1f}", file=sys.stderr)
                else:
                    print(f"[fullfix] Page {pnum}/{total}: skew={angle:.2f}\u00b0 "
                          f"conf={confidence:.1f} \u2014 no straighten needed",
                          file=sys.stderr)
            elif do_straighten and skip_str:
                print(f"[fullfix] Page {pnum}/{total}: skipped straighten (user excluded)",
                      file=sys.stderr)

            # --- Step 2: Dewarp (legacy) ---
            skip_dw = skip_dewarp_list and pnum in skip_dewarp_list
            if do_dewarp and not is_color and not skip_dw:
                from clean_pdf import dewarp_page
                dewarped, was_dewarped = dewarp_page(result)
                del result
                result = dewarped
                if was_dewarped:
                    modified = True
                print(f"[fullfix] Page {pnum}/{total}: dewarped={was_dewarped}",
                      file=sys.stderr)
            elif do_dewarp and not is_color and skip_dw:
                print(f"[fullfix] Page {pnum}/{total}: skipped dewarp (user excluded)",
                      file=sys.stderr)

        # Save pre-clean gray for OCR reuse (before clean modifies it)
        if gray_dir is not None:
            gray_path = os.path.join(gray_dir, f'gray_{pnum:04d}.npy')
            np.save(gray_path, result)

        # --- Step 3: Clean ---
        page_skip = skip_clean_list and pnum in skip_clean_list
        if do_clean and not is_color and not page_skip:
            from clean_pdf import clean_page
            cleaned = clean_page(result)
            del result
            result = cleaned
            modified = True
            print(f"[fullfix] Page {pnum}/{total}: cleaned", file=sys.stderr)

        if page_skip:
            print(f"[fullfix] Page {pnum}/{total}: skipped clean (user excluded)",
                  file=sys.stderr)
        if is_color and (do_clean or do_dewarp or do_v2):
            print(f"[fullfix] Page {pnum}/{total}: color page, "
                  f"skipping clean/dewarp/v2", file=sys.stderr)

        if modified:
            _, jpeg_buf = cv2.imencode('.jpg', result,
                                       [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            del result
            return (page_idx, jpeg_buf.tobytes(), (rect_w, rect_h))
        else:
            del result
            return (page_idx, None, (rect_w, rect_h))

    except Exception as exc:
        print(f"[fullfix] Page {pnum} fix failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (page_idx, None, (0, 0))


# ── OCR worker (module-level for multiprocessing pickling) ───────────

def _ocr_worker(args):
    """
    Worker function for parallel OCR.

    Opens the input PDF, renders one page, optionally runs v2/straighten,
    then runs OCR. Writes per-page JSON to disk for crash safety.

    When gray_dir is provided and a saved .npy file exists for this page,
    the worker skips PDF rendering and preprocessing entirely.

    Returns (page_num, ocr_result_dict) or (page_num, None) on failure.
    """
    (input_path, page_idx, total, do_v2, do_straighten, cancel_path,
     ocr_out_dir, gray_dir) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (pnum, None)

    try:
        # Try to load pre-processed gray image from fix phase
        gray_path = os.path.join(gray_dir, f'gray_{pnum:04d}.npy') if gray_dir else None
        gray = None

        if gray_path and os.path.isfile(gray_path):
            gray = np.load(gray_path)
            # Don't delete here — main process cleans up gray_dir after OCR
            print(f"[fullfix-ocr] Page {pnum}: reusing saved gray",
                  file=sys.stderr)
        else:
            # Fall back to rendering from PDF + preprocessing
            import fitz as _fitz
            doc = _fitz.open(input_path)
            page = doc[page_idx]
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.h, pix.w, pix.n).copy()
            n_ch = pix.n
            del pix

            # Detect color pages — skip OCR preprocessing on these
            is_color = False
            if n_ch >= 3:
                is_color = is_color_page(img[:, :, :3])

            if n_ch == 4:
                gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            elif n_ch == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img.copy()
            del img
            doc.close()

            # Apply v2 or legacy straighten for better OCR accuracy
            if do_v2 and not is_color:
                from scanner.scan_page import process_page_v2
                gray = process_page_v2(gray, pnum, total)
            elif do_straighten and not is_color:
                from straighten_pdf import detect_skew_from_text, straighten_page
                from straighten_pdf import DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE
                h, w = gray.shape
                scale = DETECT_WIDTH / w
                dh = int(h * scale)
                small = cv2.resize(gray, (DETECT_WIDTH, dh),
                                   interpolation=cv2.INTER_AREA)
                angle, confidence = detect_skew_from_text(small)
                del small
                if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                    gray = straighten_page(gray, angle)

        # Check cancel before the expensive Tesseract call
        if _is_cancelled(cancel_path):
            del gray
            return (pnum, None)

        from ocr import ocr_page
        result = ocr_page(gray, page_num=pnum, render_dpi=RENDER_DPI)
        del gray

        # Write per-page JSON immediately (crash-safe partial results)
        page_json = os.path.join(ocr_out_dir, f'page_{pnum:04d}.json')
        with open(page_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

        gc.collect()
        return (pnum, result)

    except Exception as exc:
        print(f"[fullfix-ocr] Page {pnum} OCR failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (pnum, None)


def run_ocr_phase(input_path, progress_file, total, do_v2, do_straighten,
                  cancel_path, tmp_dir, gray_dir=None):
    """
    Run OCR on all pages using a pool of spawn-context workers.

    When gray_dir is provided, workers reuse pre-processed gray images from
    the fix phase, skipping PDF rendering and preprocessing entirely.
    Results are saved as per-page JSON files and a combined ocr_results.json.
    """
    ocr_out_dir = os.path.join(tmp_dir, 'ocr')
    os.makedirs(ocr_out_dir, exist_ok=True)

    n_workers = _num_workers()
    write_progress(progress_file, 'ocr', 0, total)
    print(f"[fullfix-ocr] Starting OCR on {total} pages ({n_workers} workers)",
          file=sys.stderr)

    ctx = multiprocessing.get_context('spawn')
    pool = ctx.Pool(n_workers)

    tasks = [
        (input_path, idx, total, do_v2, do_straighten, cancel_path,
         ocr_out_dir, gray_dir)
        for idx in range(total)
    ]

    completed = 0
    succeeded = 0

    try:
        for pnum, result in pool.imap_unordered(_ocr_worker, tasks):
            if _is_cancelled(cancel_path):
                print("[fullfix-ocr] Cancelled, terminating pool",
                      file=sys.stderr)
                pool.terminate()
                pool.join()
                sys.exit(0)

            completed += 1
            write_progress(progress_file, 'ocr', completed, total)

            if result is not None:
                succeeded += 1
                conf = result.get('mean_conf', 0)
                words = sum(
                    len(l.get('words', []))
                    for b in result.get('blocks', [])
                    for l in b.get('lines', [])
                )
                print(f"[fullfix-ocr] Page {pnum}/{total}: "
                      f"conf={conf:.1f} words={words}",
                      file=sys.stderr)
            else:
                print(f"[fullfix-ocr] Page {pnum}/{total}: FAILED (skipped)",
                      file=sys.stderr)
    except Exception as exc:
        print(f"[fullfix-ocr] Pool error: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        pool.terminate()
        pool.join()
        raise
    else:
        pool.close()
        pool.join()

    # Assemble combined JSON from per-page files in page order
    combined = []
    for pnum in range(1, total + 1):
        page_path = os.path.join(ocr_out_dir, f'page_{pnum:04d}.json')
        if os.path.isfile(page_path):
            with open(page_path, 'r', encoding='utf-8') as f:
                combined.append(json.load(f))
        else:
            combined.append({
                'page': pnum, 'error': True, 'blocks': [], 'text': '',
            })

    combined_path = os.path.join(tmp_dir, 'ocr_results.json')
    with open(combined_path, 'w', encoding='utf-8') as f:
        json.dump(combined, f, ensure_ascii=False)

    print(f"[fullfix-ocr] Done. {succeeded}/{total} pages succeeded.",
          file=sys.stderr)


# ── Searchable PDF + sidecar ─────────────────────────────────────────

def _build_searchable_pdf(output_path, ocr_json_path):
    """Overlay invisible OCR text on the output PDF to make it searchable."""
    with open(ocr_json_path, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    doc = fitz.open(output_path)
    font = fitz.Font('helv')
    words_added = 0

    for page_data in ocr_data:
        pnum = page_data['page'] - 1
        if pnum >= len(doc):
            continue
        if page_data.get('error'):
            continue

        page = doc[pnum]
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
    print(f"[fullfix] Searchable PDF: {words_added} words embedded",
          file=sys.stderr)


def _write_text_sidecar(ocr_json_path, txt_path):
    """Write plain-text sidecar from OCR results."""
    with open(ocr_json_path, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    with open(txt_path, 'w', encoding='utf-8') as out:
        for page_data in ocr_data:
            pnum = page_data['page']
            text = page_data.get('text', '')
            header = page_data.get('header', '')
            footer = page_data.get('footer', '')

            out.write(f'--- Page {pnum} ---\n')
            if header:
                out.write(header + '\n')
            if text:
                out.write(text + '\n')
            if footer:
                out.write(footer + '\n')
            out.write('\n')

    print(f"[fullfix] Text sidecar written: {txt_path}", file=sys.stderr)


# ── Main pipeline ────────────────────────────────────────────────────

def process_pdf(input_path, output_path, progress_file, book_name='fixed',
                do_straighten=True, do_clean=True, do_dewarp=True, do_v2=False,
                skip_clean_pages=None, gray_dir=None,
                skip_straighten_pages=None, skip_dewarp_pages=None):
    print(f"[fullfix] Opening {input_path}", file=sys.stderr)
    print(f"[fullfix] straighten={do_straighten}, clean={do_clean}, dewarp={do_dewarp}, v2={do_v2}"
          f", skip_clean={skip_clean_pages or 'none'}"
          f", skip_straighten={skip_straighten_pages or 'none'}"
          f", skip_dewarp={skip_dewarp_pages or 'none'}",
          file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    n_workers = _num_workers()
    print(f"[fullfix] Starting fix on {total} pages ({n_workers} workers)",
          file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)

    tmp_dir = os.path.dirname(output_path)
    cancel_path = os.path.join(tmp_dir, '_cancel')
    batch_files = []
    batch_doc = fitz.open()
    pages_in_batch = 0

    # Convert sets to sorted lists for pickling across spawn-context workers
    skip_clean_list = sorted(skip_clean_pages) if skip_clean_pages else []
    skip_straighten_list = sorted(skip_straighten_pages) if skip_straighten_pages else []
    skip_dewarp_list = sorted(skip_dewarp_pages) if skip_dewarp_pages else []

    ctx = multiprocessing.get_context('spawn')
    pool = ctx.Pool(n_workers)

    tasks = [
        (input_path, idx, total, do_straighten, do_clean, do_dewarp, do_v2,
         skip_clean_list, cancel_path, gray_dir,
         skip_straighten_list, skip_dewarp_list)
        for idx in range(total)
    ]

    # main_doc kept open for copying unmodified pages
    main_doc = fitz.open(input_path)

    try:
        for page_idx, jpeg_bytes, rect_wh in pool.imap(_fix_worker, tasks):
            if _is_cancelled(cancel_path):
                print("[fullfix] Cancelled by user", file=sys.stderr)
                pool.terminate()
                pool.join()
                batch_doc.close()
                main_doc.close()
                doc.close()
                sys.exit(0)

            pnum = page_idx + 1
            write_progress(progress_file, 'fixing', pnum, total)

            if jpeg_bytes is not None:
                w, h = rect_wh
                new_page = batch_doc.new_page(width=w, height=h)
                new_page.insert_image(fitz.Rect(0, 0, w, h), stream=jpeg_bytes)
                del jpeg_bytes
            else:
                # Unmodified page or worker error — copy original
                batch_doc.insert_pdf(main_doc, from_page=page_idx, to_page=page_idx)

            pages_in_batch += 1
            gc.collect()

            # Flush batch to disk to free memory
            if pages_in_batch >= BATCH_SIZE and pnum < total:
                batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
                batch_doc.save(batch_path, deflate=True)
                batch_doc.close()
                batch_files.append(batch_path)
                batch_doc = fitz.open()
                pages_in_batch = 0
                gc.collect()
                print(f"[fullfix] Flushed batch {len(batch_files)} to disk "
                      f"({pnum}/{total})", file=sys.stderr)
    except Exception:
        pool.terminate()
        pool.join()
        batch_doc.close()
        main_doc.close()
        doc.close()
        raise
    else:
        pool.close()
        pool.join()
        main_doc.close()
        doc.close()

    # Save the last (possibly only) batch
    last_batch = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
    batch_doc.save(last_batch, deflate=True)
    batch_doc.close()
    batch_files.append(last_batch)
    gc.collect()

    # Signal saving phase so the UI doesn't stay stuck at 100%
    write_progress(progress_file, 'saving', total, total)

    # Merge batches incrementally — only 2 PDFs in memory at a time
    print(f"[fullfix] Merging {len(batch_files)} batch(es)", file=sys.stderr)
    metadata = {'title': book_name, 'producer': 'Straight Up \u2013 Full Fix'}
    _merge_batches(batch_files, output_path, metadata)

    print("[fullfix] Processing done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 7:
        print("Usage: python fullfix_pdf.py <input> <output> <progress_file> "
              "<book_name> <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1] "
              "[skip_clean:1,3,5] [ocr:0|1]",
              file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    name = sys.argv[4]
    straighten = sys.argv[5] == '1'
    clean = sys.argv[6] == '1'
    dewarp = sys.argv[7] == '1' if len(sys.argv) > 7 else False
    v2 = sys.argv[8] == '1' if len(sys.argv) > 8 else False
    skip_clean_raw = sys.argv[9] if len(sys.argv) > 9 else ''
    skip_clean = set()
    if skip_clean_raw:
        for tok in skip_clean_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_clean.add(int(tok))
    ocr = sys.argv[10] == '1' if len(sys.argv) > 10 else False

    skip_straighten_raw = sys.argv[11] if len(sys.argv) > 11 else ''
    skip_straighten = set()
    if skip_straighten_raw:
        for tok in skip_straighten_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_straighten.add(int(tok))

    skip_dewarp_raw = sys.argv[12] if len(sys.argv) > 12 else ''
    skip_dewarp = set()
    if skip_dewarp_raw:
        for tok in skip_dewarp_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_dewarp.add(int(tok))

    has_processing = straighten or clean or dewarp or v2

    if not has_processing and not ocr:
        print("[fullfix] Nothing to do \u2014 all options disabled", file=sys.stderr)
        sys.exit(1)

    tmp_dir = os.path.dirname(os.path.abspath(out))
    cancel_path = os.path.join(tmp_dir, '_cancel')

    # Create gray_dir for sharing pre-processed images between fix and OCR
    gray_dir = None
    if has_processing and ocr:
        gray_dir = os.path.join(tmp_dir, 'gray')
        os.makedirs(gray_dir, exist_ok=True)

    try:
        if has_processing:
            process_pdf(inp, out, prog, name, straighten, clean, dewarp, v2,
                        skip_clean or None, gray_dir=gray_dir,
                        skip_straighten_pages=skip_straighten or None,
                        skip_dewarp_pages=skip_dewarp or None)
        elif ocr:
            # OCR-only mode: copy input to output unchanged
            shutil.copy2(inp, out)
            print(f"[fullfix] OCR-only mode \u2014 copied input to output",
                  file=sys.stderr)

        if ocr:
            doc = fitz.open(inp)
            total = len(doc)
            doc.close()
            run_ocr_phase(inp, prog, total, v2, straighten, cancel_path,
                          tmp_dir, gray_dir=gray_dir)

            # Clean up gray files after OCR is done
            if gray_dir and os.path.isdir(gray_dir):
                shutil.rmtree(gray_dir, ignore_errors=True)

            # Build searchable PDF + sidecar files
            ocr_json_path = os.path.join(tmp_dir, 'ocr_results.json')
            if os.path.isfile(ocr_json_path):
                write_progress(prog, 'saving', 0, 0)
                _build_searchable_pdf(out, ocr_json_path)
                _write_text_sidecar(ocr_json_path,
                                    os.path.join(tmp_dir, 'ocr_text.txt'))

        write_progress(prog, 'done', 0, 0)
    except SystemExit:
        raise
    except Exception as e:
        print(f"[fullfix] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
