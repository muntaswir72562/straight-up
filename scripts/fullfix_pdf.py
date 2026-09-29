#!/usr/bin/env python3
"""
Full Book Fix PDF processing pipeline (server-side).

Combines straightening, dewarping, and cleaning in a single pass.
For each page:
  1. Render at target DPI via pymupdf
  2. (if straighten) Detect skew via text line analysis, rotate to fix
  3. (if dewarp) Dewarp curved text lines
  4. (if clean) Clean background/bleed-through
  5. Add to output PDF

Usage:
  python fullfix_pdf.py <input> <output> <progress_file> <book_name> <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1]

Progress is written to <progress_file> as JSON after each page:
  {"phase": "fixing", "current": 5, "total": 50}
"""

import sys
import os
import gc
import json
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

from straighten_pdf import detect_skew_from_text, straighten_page
from straighten_pdf import DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE
from clean_pdf import dewarp_page, clean_page

# ── Constants ────────────────────────────────────────────────────────
RENDER_DPI = 200
JPEG_QUALITY = 92
BATCH_SIZE = 20  # pages per batch before flushing to disk


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


# ── Main pipeline ────────────────────────────────────────────────────

def process_page(doc, idx, do_straighten, do_clean, do_dewarp, do_v2, total):
    """Process a single page. Returns (jpeg_bytes, rect) if modified, else None."""
    pnum = idx + 1
    page = doc[idx]

    pix = page.get_pixmap(dpi=RENDER_DPI)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n).copy()
    n_channels = pix.n
    rect = page.rect
    del pix

    # Detect color pages (covers, illustrations) — skip cleaning/dewarping on these
    is_color = False
    if (do_clean or do_dewarp or do_v2) and n_channels >= 3:
        hsv = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2HSV)
        mean_sat = float(np.mean(hsv[:, :, 1]))
        is_color = mean_sat > 20
        del hsv

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
    if do_v2 and not is_color:
        from scanner.scan_page import process_page_v2
        result = process_page_v2(result, pnum, total)
        modified = True
    else:
        # --- Step 1: Straighten (legacy) ---
        if do_straighten:
            h, w = result.shape
            scale = DETECT_WIDTH / w
            dh = int(h * scale)
            small = cv2.resize(result, (DETECT_WIDTH, dh), interpolation=cv2.INTER_AREA)
            angle, confidence = detect_skew_from_text(small)
            del small

            if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                result = straighten_page(result, angle)
                modified = True
                print(f"[fullfix] Page {pnum}/{total}: straightened {angle:.2f}\u00b0 "
                      f"conf={confidence:.1f}", file=sys.stderr)
            else:
                print(f"[fullfix] Page {pnum}/{total}: skew={angle:.2f}\u00b0 "
                      f"conf={confidence:.1f} \u2014 no straighten needed", file=sys.stderr)

        # --- Step 2: Dewarp (legacy) ---
        if do_dewarp and not is_color:
            dewarped, was_dewarped = dewarp_page(result)
            del result
            result = dewarped
            if was_dewarped:
                modified = True
            print(f"[fullfix] Page {pnum}/{total}: dewarped={was_dewarped}", file=sys.stderr)

    # --- Step 3: Clean (independent, runs after either v2 or legacy path) ---
    if do_clean and not is_color:
        cleaned = clean_page(result)
        del result
        result = cleaned
        modified = True
        print(f"[fullfix] Page {pnum}/{total}: cleaned", file=sys.stderr)

    if is_color and (do_clean or do_dewarp or do_v2):
        print(f"[fullfix] Page {pnum}/{total}: color page, "
              f"skipping clean/dewarp/v2", file=sys.stderr)

    if modified:
        _, jpeg_buf = cv2.imencode('.jpg', result,
                                   [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        del result
        return jpeg_buf.tobytes(), rect
    else:
        del result
        return None


def process_pdf(input_path, output_path, progress_file, book_name='fixed',
                do_straighten=True, do_clean=True, do_dewarp=True, do_v2=False):
    print(f"[fullfix] Opening {input_path}", file=sys.stderr)
    print(f"[fullfix] straighten={do_straighten}, clean={do_clean}, dewarp={do_dewarp}, v2={do_v2}",
          file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    print(f"[fullfix] {total} pages", file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)

    tmp_dir = os.path.dirname(output_path)
    batch_files = []
    batch_doc = fitz.open()
    pages_in_batch = 0

    for idx in range(total):
        pnum = idx + 1
        write_progress(progress_file, 'fixing', pnum, total)

        try:
            page_result = process_page(doc, idx, do_straighten, do_clean, do_dewarp, do_v2, total)

            if page_result is not None:
                jpeg_bytes, rect = page_result
                new_page = batch_doc.new_page(width=rect.width, height=rect.height)
                new_page.insert_image(rect, stream=jpeg_bytes)
                del jpeg_bytes
            else:
                batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)

        except Exception:
            print(f"[fullfix] Page {pnum} failed:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)

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

    write_progress(progress_file, 'done', total, total)
    print("[fullfix] Done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 7:
        print("Usage: python fullfix_pdf.py <input> <output> <progress_file> "
              "<book_name> <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1]",
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

    if not straighten and not clean and not dewarp and not v2:
        print("[fullfix] Nothing to do — all options disabled", file=sys.stderr)
        sys.exit(1)

    try:
        process_pdf(inp, out, prog, name, straighten, clean, dewarp, v2)
    except Exception as e:
        print(f"[fullfix] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
