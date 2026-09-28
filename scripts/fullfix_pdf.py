#!/usr/bin/env python3
"""
Full Book Fix PDF processing pipeline (server-side).

Combines straightening and cleaning/dewarping in a single pass.
For each page:
  1. Render at target DPI via pymupdf
  2. (if straighten) Detect skew via text line analysis, rotate to fix
  3. (if clean) Dewarp curved text lines + clean background/bleed-through
  4. Add to output PDF

Usage:
  python fullfix_pdf.py <input> <output> <progress_file> <book_name> <straighten:0|1> <clean:0|1>

Progress is written to <progress_file> as JSON after each page:
  {"phase": "fixing", "current": 5, "total": 50}
"""

import sys
import os
import json
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


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Main pipeline ────────────────────────────────────────────────────

def process_pdf(input_path, output_path, progress_file, book_name='fixed',
                do_straighten=True, do_clean=True):
    print(f"[fullfix] Opening {input_path}", file=sys.stderr)
    print(f"[fullfix] straighten={do_straighten}, clean={do_clean}", file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    print(f"[fullfix] {total} pages", file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)
    out_doc = fitz.open()

    for idx in range(total):
        pnum = idx + 1
        write_progress(progress_file, 'fixing', pnum, total)

        page = doc[idx]
        try:
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)

            # Detect color pages (covers, illustrations) — skip cleaning on these
            is_color = False
            if do_clean and pix.n >= 3:
                hsv = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2HSV)
                mean_sat = float(np.mean(hsv[:, :, 1]))
                is_color = mean_sat > 20

            if pix.n == 4:
                gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            elif pix.n == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img.copy()

            modified = False
            result = gray

            # --- Step 1: Straighten ---
            if do_straighten:
                h, w = result.shape
                scale = DETECT_WIDTH / w
                dh = int(h * scale)
                small = cv2.resize(result, (DETECT_WIDTH, dh), interpolation=cv2.INTER_AREA)

                angle, confidence = detect_skew_from_text(small)

                if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                    result = straighten_page(result, angle)
                    modified = True
                    print(f"[fullfix] Page {pnum}/{total}: straightened {angle:.2f}° "
                          f"conf={confidence:.1f}", file=sys.stderr)
                else:
                    print(f"[fullfix] Page {pnum}/{total}: skew={angle:.2f}° "
                          f"conf={confidence:.1f} — no straighten needed", file=sys.stderr)

            # --- Step 2: Clean & Dewarp ---
            if do_clean and not is_color:
                dewarped, was_dewarped = dewarp_page(result)
                cleaned = clean_page(dewarped)
                result = cleaned
                modified = True
                print(f"[fullfix] Page {pnum}/{total}: cleaned, "
                      f"dewarped={was_dewarped}", file=sys.stderr)
            elif is_color:
                print(f"[fullfix] Page {pnum}/{total}: color page, "
                      f"skipping clean", file=sys.stderr)

            # --- Output ---
            if modified:
                _, jpeg_buf = cv2.imencode('.jpg', result,
                                           [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                rect = page.rect
                new_page = out_doc.new_page(width=rect.width, height=rect.height)
                new_page.insert_image(rect, stream=jpeg_buf.tobytes())
            else:
                out_doc.insert_pdf(doc, from_page=idx, to_page=idx)

        except Exception:
            print(f"[fullfix] Page {pnum} failed:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            out_doc.insert_pdf(doc, from_page=idx, to_page=idx)

    out_doc.set_metadata({'title': book_name, 'producer': 'Straight Up – Full Fix'})

    print(f"[fullfix] Saving to {output_path}", file=sys.stderr)
    out_doc.save(output_path, deflate=True, garbage=3)
    out_doc.close()
    doc.close()

    write_progress(progress_file, 'done', total, total)
    print("[fullfix] Done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 7:
        print("Usage: python fullfix_pdf.py <input> <output> <progress_file> "
              "<book_name> <straighten:0|1> <clean:0|1>",
              file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    name = sys.argv[4]
    straighten = sys.argv[5] == '1'
    clean = sys.argv[6] == '1'

    if not straighten and not clean:
        print("[fullfix] Nothing to do — both options disabled", file=sys.stderr)
        sys.exit(1)

    try:
        process_pdf(inp, out, prog, name, straighten, clean)
    except Exception as e:
        print(f"[fullfix] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
