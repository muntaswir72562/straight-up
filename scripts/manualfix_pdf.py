#!/usr/bin/env python3
"""
Manual Fix PDF processing pipeline (server-side).

For each page, applies user-specified edits:
  1. Rotation (arbitrary angle)
  2. Perspective correction (X/Y axis tilt)
  3. Levels adjustment (black/white point)

Pages without edits AND default levels are copied losslessly.

Usage:
  python manualfix_pdf.py <input.pdf> <output.pdf> <progress.json> <settings.json> <book_name>

Settings JSON format:
  {
    "levels": { "blackPoint": 0, "whitePoint": 255 },
    "edits": {
      "3": { "rotation": 2.5, "perspectiveX": 3.0, "perspectiveY": -1.5 },
      "7": { "rotation": -1.2, "perspectiveX": 0, "perspectiveY": 0 }
    }
  }
"""

import sys
import gc
import json
import os
import traceback
import numpy as np
import cv2

try:
    import fitz  # pymupdf
except ImportError:
    print("Error: pymupdf required. Install: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


# -- Constants ----------------------------------------------------------------
RENDER_DPI = 200
JPEG_QUALITY = 92
BATCH_SIZE = 20


# -- Progress -----------------------------------------------------------------

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# -- Levels adjustment --------------------------------------------------------

def apply_levels(img, black_point, white_point):
    """Apply input-levels stretch: remap [bp, wp] -> [0, 255]."""
    bp = max(0, min(254, black_point))
    wp = max(bp + 1, min(255, white_point))
    scale = 255.0 / (wp - bp)
    result = np.clip((img.astype(np.float32) - bp) * scale, 0, 255).astype(np.uint8)
    return result


# -- Perspective correction ---------------------------------------------------

def apply_perspective(img, rotate_x_deg, rotate_y_deg):
    """
    Apply perspective correction by rotating around X and/or Y axes.
    Empty areas are filled white and blended at edges.
    """
    h, w = img.shape[:2]
    is_color = len(img.shape) == 3

    rx = np.radians(rotate_x_deg)
    ry = np.radians(rotate_y_deg)

    # Focal length controls perspective intensity
    f = float(max(w, h)) * 1.5

    # Camera intrinsic matrix
    K = np.array([[f, 0, w / 2.0],
                  [0, f, h / 2.0],
                  [0, 0, 1.0]], dtype=np.float64)

    # Rotation around X axis (tilt forward/back)
    Rx = np.array([[1, 0, 0],
                   [0, np.cos(rx), -np.sin(rx)],
                   [0, np.sin(rx), np.cos(rx)]], dtype=np.float64)

    # Rotation around Y axis (tilt left/right)
    Ry = np.array([[np.cos(ry), 0, np.sin(ry)],
                   [0, 1, 0],
                   [-np.sin(ry), 0, np.cos(ry)]], dtype=np.float64)

    # Combined homography: H = K * Ry * Rx * K_inv
    R = Ry @ Rx
    H = K @ R @ np.linalg.inv(K)

    border_val = (255, 255, 255) if is_color else 255
    warped = cv2.warpPerspective(img, H, (w, h),
                                 flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT,
                                 borderValue=border_val)

    # Blend edges: warp a ones-mask with same H, blur for feathering
    mask = np.ones((h, w), dtype=np.float32)
    warped_mask = cv2.warpPerspective(mask, H, (w, h),
                                      flags=cv2.INTER_LINEAR,
                                      borderMode=cv2.BORDER_CONSTANT,
                                      borderValue=0)
    del mask

    blend_mask = cv2.GaussianBlur(warped_mask, (21, 21), 0)
    blend_mask = np.clip(blend_mask, 0, 1)
    del warped_mask

    if is_color:
        bm3 = blend_mask[:, :, np.newaxis]
        white_bg = np.full_like(warped, 255)
        result = (warped.astype(np.float32) * bm3 +
                  white_bg.astype(np.float32) * (1.0 - bm3))
        del bm3, white_bg, blend_mask
    else:
        white_bg = np.full_like(warped, 255)
        result = (warped.astype(np.float32) * blend_mask +
                  white_bg.astype(np.float32) * (1.0 - blend_mask))
        del white_bg, blend_mask

    del warped
    return np.clip(result, 0, 255).astype(np.uint8)


# -- Incremental merge --------------------------------------------------------

def _merge_batches(batch_files, output_path, metadata):
    """Merge batch PDFs into output one at a time to cap memory usage."""
    if len(batch_files) == 1:
        doc = fitz.open(batch_files[0])
        doc.set_metadata(metadata)
        doc.save(output_path, deflate=True, garbage=3)
        doc.close()
        os.remove(batch_files[0])
        return

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

    final = fitz.open(output_path)
    final.set_metadata(metadata)
    final.save(output_path, incremental=True, encryption=0)
    final.close()


# -- Main pipeline ------------------------------------------------------------

def process_pdf(input_path, output_path, progress_file, settings, book_name='manual-fixed'):
    print(f"[manualfix] Opening {input_path}", file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    print(f"[manualfix] {total} pages", file=sys.stderr)

    levels = settings.get('levels', {'blackPoint': 0, 'whitePoint': 255})
    edits = settings.get('edits', {})

    bp = levels.get('blackPoint', 0)
    wp = levels.get('whitePoint', 255)
    has_levels = bp > 0 or wp < 255

    print(f"[manualfix] levels: bp={bp}, wp={wp}, edits on pages: {list(edits.keys())}",
          file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)

    tmp_dir = os.path.dirname(output_path)
    batch_files = []
    batch_doc = fitz.open()
    pages_in_batch = 0

    for idx in range(total):
        pnum = idx + 1
        write_progress(progress_file, 'manualfixing', pnum, total)

        page_edit = edits.get(str(pnum))

        has_rotation = (page_edit is not None and
                        abs(page_edit.get('rotation', 0)) > 0.01)
        has_perspective = (page_edit is not None and
                          (abs(page_edit.get('perspectiveX', 0)) > 0.01 or
                           abs(page_edit.get('perspectiveY', 0)) > 0.01))

        needs_processing = has_levels or has_rotation or has_perspective

        if not needs_processing:
            # Copy original page losslessly
            batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)
            pages_in_batch += 1
            gc.collect()

            if pages_in_batch >= BATCH_SIZE and pnum < total:
                batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
                batch_doc.save(batch_path, deflate=True)
                batch_doc.close()
                batch_files.append(batch_path)
                batch_doc = fitz.open()
                pages_in_batch = 0
                gc.collect()
                print(f"[manualfix] Flushed batch {len(batch_files)} to disk "
                      f"({pnum}/{total})", file=sys.stderr)
            continue

        page = doc[idx]
        try:
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.h, pix.w, pix.n).copy()
            n_channels = pix.n
            rect = page.rect
            del pix

            # Keep color for color pages, convert to gray for grayscale
            if n_channels == 1:
                result = img
            elif n_channels == 4:
                result = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            else:
                # Check if page is color
                hsv = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2HSV)
                mean_sat = float(np.mean(hsv[:, :, 1]))
                del hsv
                if mean_sat > 20:
                    # Color page — keep as RGB
                    result = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
                else:
                    result = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            del img

            # Step 1: Rotation
            if has_rotation:
                angle = page_edit['rotation']
                rh, rw = result.shape[:2]
                center = (rw / 2.0, rh / 2.0)
                M = cv2.getRotationMatrix2D(center, angle, 1.0)
                is_color_img = len(result.shape) == 3
                bv = (255, 255, 255) if is_color_img else 255
                result = cv2.warpAffine(result, M, (rw, rh),
                                        flags=cv2.INTER_LINEAR,
                                        borderMode=cv2.BORDER_CONSTANT,
                                        borderValue=bv)
                print(f"[manualfix] Page {pnum}/{total}: rotated {angle:.2f}\u00b0",
                      file=sys.stderr)

            # Step 2: Perspective
            if has_perspective:
                px = page_edit.get('perspectiveX', 0)
                py = page_edit.get('perspectiveY', 0)
                result = apply_perspective(result, px, py)
                print(f"[manualfix] Page {pnum}/{total}: perspective X={px:.1f}\u00b0 Y={py:.1f}\u00b0",
                      file=sys.stderr)

            # Step 3: Levels
            if has_levels:
                result = apply_levels(result, bp, wp)

            _, jpeg_buf = cv2.imencode('.jpg', result,
                                       [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            del result

            new_page = batch_doc.new_page(width=rect.width, height=rect.height)
            new_page.insert_image(rect, stream=jpeg_buf.tobytes())
            del jpeg_buf

            print(f"[manualfix] Page {pnum}/{total}: processed", file=sys.stderr)

        except Exception:
            print(f"[manualfix] Page {pnum} failed:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)

        pages_in_batch += 1
        gc.collect()

        if pages_in_batch >= BATCH_SIZE and pnum < total:
            batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
            batch_doc.save(batch_path, deflate=True)
            batch_doc.close()
            batch_files.append(batch_path)
            batch_doc = fitz.open()
            pages_in_batch = 0
            gc.collect()
            print(f"[manualfix] Flushed batch {len(batch_files)} to disk "
                  f"({pnum}/{total})", file=sys.stderr)

    doc.close()

    # Save the last batch
    last_batch = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
    batch_doc.save(last_batch, deflate=True)
    batch_doc.close()
    batch_files.append(last_batch)
    gc.collect()

    print(f"[manualfix] Merging {len(batch_files)} batch(es)", file=sys.stderr)
    metadata = {'title': book_name, 'producer': 'Straight Up \u2013 Manual Fix'}
    _merge_batches(batch_files, output_path, metadata)

    write_progress(progress_file, 'done', total, total)
    print("[manualfix] Done!", file=sys.stderr)


# -- Entry point --------------------------------------------------------------

if __name__ == '__main__':
    if len(sys.argv) < 6:
        print("Usage: python manualfix_pdf.py <input> <output> <progress> "
              "<settings.json> <book_name>", file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    settings_path = sys.argv[4]
    name = sys.argv[5]

    with open(settings_path, 'r') as f:
        settings = json.load(f)

    try:
        process_pdf(inp, out, prog, settings, name)
    except Exception as e:
        print(f"[manualfix] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
