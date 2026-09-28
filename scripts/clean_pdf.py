#!/usr/bin/env python3
"""
Clean & Dewarp PDF processing pipeline (server-side).

For each page:
  1. Render at target DPI via pymupdf
  2. Dewarp (detect curved text lines, fit quadratic polynomials, remap)
  3. Clean (division-based background normalization, contrast stretch - NO binarization)
  4. Add to output PDF

Usage:
  python clean_pdf.py <input.pdf> <output.pdf> <progress_file> [book_name]

Progress is written to <progress_file> as JSON after each page:
  {"phase": "cleaning", "current": 5, "total": 50}

On completion:
  {"phase": "done", "current": 50, "total": 50}
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

try:
    from scipy.ndimage import gaussian_filter
except ImportError:
    print("Error: scipy required. Install: pip install scipy", file=sys.stderr)
    sys.exit(1)


# ── Constants ────────────────────────────────────────────────────────
RENDER_DPI = 200
DETECT_WIDTH = 1000
BATCH_SIZE = 50
MIN_LINE_WIDTH_RATIO = 0.12
MIN_LINES = 3
DILATION_H = 50
DILATION_V = 3
MIN_CURVATURE = 3.0        # median curvature threshold — only correct noticeable warping
MAX_CURVATURE = 20.0       # reject lines with curvature above this (likely bad fits)
MAX_FIT_RESIDUAL = 5.0     # max RMS residual for accepted fit
MARGIN_FRACTION = 0.03     # ignore this fraction at page edges
BG_KERNEL_SIZE = 51        # morphological closing kernel for background
BLUR_SIZE = 3              # Gaussian blur kernel
JPEG_QUALITY = 90

# Straighten (deskew) constants
MAX_SKEW_ANGLE = 10.0      # max detectable skew (degrees)
MIN_SKEW_ANGLE = 0.15      # below this, don't bother rotating
EDGE_ZONE_FRAC = 0.22      # fraction of width for left/right edge zones
ZONE_AGREE_THRESH = 1.5    # max degrees difference for zones to agree
MAX_SINGLE_ZONE = 1.0      # cap angle when only one zone detected
SKEW_DAMPING = 0.7         # dampen detected angle to avoid overcorrection
MIN_SKEW_CONFIDENCE = 1.5  # minimum confidence to accept detection


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Text-line detection ──────────────────────────────────────────────

def sample_midline(binary, x_off, y_off, cw, ch):
    """Centre-of-mass of ink per column inside a bounding box."""
    pts = []
    step = max(2, cw // 40)
    for lx in range(step, cw - step, step):
        ax = lx + x_off
        if ax >= binary.shape[1]:
            continue
        col = binary[y_off:y_off + ch, ax]
        ink = np.where(col > 0)[0]
        if len(ink) >= 2:
            pts.append((float(ax), float(y_off + np.mean(ink))))
    return pts


def detect_text_lines(gray, width, height):
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 10,
    )
    h_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (DILATION_H, DILATION_V))
    dilated = cv2.dilate(binary, h_kern, iterations=2)
    c_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (DILATION_H // 2, 1))
    closed = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, c_kern)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_w = width * MIN_LINE_WIDTH_RATIO
    lines = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        if cw < min_w or ch > height * 0.08 or ch < 3:
            continue
        if cw / max(ch, 1) < 2.5:
            continue
        if y <= 1 or y + ch >= height - 1:
            continue
        ml = sample_midline(binary, x, y, cw, ch)
        if len(ml) >= 8:
            lines.append({'bbox': (x, y, cw, ch), 'centerY': y + ch / 2, 'midline': ml})
    lines.sort(key=lambda l: l['centerY'])
    return lines


# ── Curve fitting ────────────────────────────────────────────────────

def fit_line_curves(lines, img_width):
    margin = img_width * MARGIN_FRACTION
    fitted = []
    for line in lines:
        pts = [(x, y) for x, y in line['midline'] if margin < x < img_width - margin]
        if len(pts) < 6:
            continue
        xs = np.array([p[0] for p in pts])
        ys = np.array([p[1] for p in pts])
        try:
            coeffs = np.polyfit(xs, ys, 2)
        except np.linalg.LinAlgError:
            continue

        # Outlier rejection
        res = np.abs(ys - np.polyval(coeffs, xs))
        thr = max(np.median(res) * 3, 2.0)
        mask = res < thr
        if mask.sum() < 6:
            continue
        try:
            coeffs = np.polyfit(xs[mask], ys[mask], 2)
        except np.linalg.LinAlgError:
            continue

        fys = np.polyval(coeffs, xs[mask])
        rms = np.sqrt(np.mean((ys[mask] - fys) ** 2))
        if rms > MAX_FIT_RESIDUAL:
            continue
        ideal_y = float(np.mean(fys))
        curvature = float(np.max(np.abs(fys - ideal_y)))
        fitted.append({
            'points': list(zip(xs[mask].tolist(), ys[mask].tolist())),
            'coeffs': coeffs,
            'idealY': ideal_y,
            'curvature': curvature,
        })
    return fitted


# ── Displacement field ───────────────────────────────────────────────

def build_displacement_field(fitted_lines, width, height):
    if len(fitted_lines) < MIN_LINES:
        return None
    field = np.zeros((height, width), dtype=np.float32)

    for x in range(0, width, 2):
        samples = []
        for line in fitted_lines:
            xs_arr = [p[0] for p in line['points']]
            if xs_arr[0] <= x <= xs_arr[-1]:
                fy = float(np.polyval(line['coeffs'], x))
                dy = line['idealY'] - fy
                samples.append((fy, dy))
        samples.sort()
        if samples:
            samples.insert(0, (0.0, 0.0))
            samples.append((float(height - 1), 0.0))
        if len(samples) >= 2:
            sy = np.array([s[0] for s in samples])
            sd = np.array([s[1] for s in samples])
            col_dy = np.interp(np.arange(height, dtype=np.float32), sy, sd)
            field[:, x] = col_dy
            if x + 1 < width:
                field[:, x + 1] = col_dy

    field = gaussian_filter(field, sigma=(15, 30))
    return field


# ── Dewarp ───────────────────────────────────────────────────────────

def dewarp_page(gray):
    """Returns (result_gray, was_dewarped)."""
    h, w = gray.shape
    scale = DETECT_WIDTH / w
    dh = int(h * scale)
    small = cv2.resize(gray, (DETECT_WIDTH, dh), interpolation=cv2.INTER_AREA)

    lines = detect_text_lines(small, DETECT_WIDTH, dh)
    if len(lines) < MIN_LINES:
        return gray, False

    fitted = fit_line_curves(lines, DETECT_WIDTH)
    if len(fitted) < MIN_LINES:
        return gray, False

    # Remove outlier curves: reject lines with curvature > MAX_CURVATURE
    # or > 4× the median curvature (likely bad fits, not real warping)
    curvatures = [fl['curvature'] for fl in fitted]
    med_curv = float(np.median(curvatures))
    curv_limit = min(MAX_CURVATURE, max(med_curv * 4, MIN_CURVATURE * 2))
    fitted = [fl for fl in fitted if fl['curvature'] <= curv_limit]
    if len(fitted) < MIN_LINES:
        return gray, False

    med_curv2 = float(np.median([fl['curvature'] for fl in fitted]))
    if med_curv2 < MIN_CURVATURE:
        return gray, False

    dy_field = build_displacement_field(fitted, DETECT_WIDTH, dh)
    if dy_field is None:
        return gray, False

    # Up-scale field to original resolution
    full_field = cv2.resize(dy_field, (w, h), interpolation=cv2.INTER_LINEAR) / scale

    map_x = np.tile(np.arange(w, dtype=np.float32), (h, 1))
    map_y = np.tile(np.arange(h, dtype=np.float32).reshape(-1, 1), (1, w))
    map_y = (map_y - full_field).astype(np.float32)

    dewarped = cv2.remap(gray, map_x, map_y, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    return dewarped, True


# ── Clean ────────────────────────────────────────────────────────────

def clean_page(gray):
    """
    Normalize background to white, remove bleed-through, enhance contrast.
    Does NOT binarize — preserves natural text weight and anti-aliasing.
    """
    blurred = cv2.GaussianBlur(gray, (BLUR_SIZE, BLUR_SIZE), 0)

    # Background estimation via large morphological closing
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (BG_KERNEL_SIZE, BG_KERNEL_SIZE))
    bg = cv2.morphologyEx(blurred, cv2.MORPH_CLOSE, kern)

    # Division normalization (paper tone → white)
    normalized = cv2.divide(blurred, bg, scale=255)

    # Remove bleed-through: morphological opening on inverted image
    # erodes then dilates — removes thin/faint features (bleed-through)
    # while preserving thicker features (actual text)
    inverted = cv2.bitwise_not(normalized)
    open_kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    opened = cv2.morphologyEx(inverted, cv2.MORPH_OPEN, open_kern)
    no_bleed = cv2.bitwise_not(opened)

    # Otsu white-point stretch: Otsu finds the threshold between text and
    # background.  Map everything above it to 255 (white), stretch the dark
    # text range proportionally so real text stays dark and natural.
    otsu_val, _ = cv2.threshold(no_bleed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    white_pt = float(otsu_val)

    # Black point: 5th percentile of pixels darker than Otsu (actual text)
    dark_pixels = no_bleed[no_bleed < otsu_val]
    if len(dark_pixels) > 100:
        black_pt = float(np.percentile(dark_pixels, 5))
    else:
        black_pt = 0.0

    if white_pt - black_pt < 10:
        white_pt = black_pt + 10

    stretched = np.clip(
        (no_bleed.astype(np.float32) - black_pt) / (white_pt - black_pt) * 255,
        0, 255,
    ).astype(np.uint8)
    return stretched


# ── Incremental merge ────────────────────────────────────────────────

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


# ── Main pipeline ────────────────────────────────────────────────────

def process_pdf(input_path, output_path, progress_file, book_name='cleaned'):
    print(f"[clean-pdf] Opening {input_path}", file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    print(f"[clean-pdf] {total} pages", file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)

    tmp_dir = os.path.dirname(output_path)
    batch_files = []
    batch_doc = fitz.open()
    pages_in_batch = 0

    for idx in range(total):
        pnum = idx + 1
        write_progress(progress_file, 'cleaning', pnum, total)

        page = doc[idx]
        try:
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n).copy()
            n_channels = pix.n
            rect = page.rect
            del pix

            # Detect color pages (covers, illustrations) and skip them
            is_color = False
            if n_channels >= 3:
                hsv = cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2HSV)
                mean_sat = float(np.mean(hsv[:, :, 1]))
                is_color = mean_sat > 20
                del hsv

            if is_color:
                print(f"[clean-pdf] Page {pnum}/{total}: color page, copying as-is",
                      file=sys.stderr)
                del img
                batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)
                pages_in_batch += 1
                if pages_in_batch >= BATCH_SIZE and pnum < total:
                    batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
                    batch_doc.save(batch_path, deflate=True)
                    batch_doc.close()
                    batch_files.append(batch_path)
                    batch_doc = fitz.open()
                    pages_in_batch = 0
                    gc.collect()
                continue

            if n_channels == 4:
                gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            elif n_channels == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img.copy()
            del img

            print(f"[clean-pdf] Page {pnum}/{total}: {gray.shape[1]}x{gray.shape[0]}",
                  file=sys.stderr)

            dewarped, was_dewarped = dewarp_page(gray)
            del gray
            cleaned = clean_page(dewarped)
            del dewarped

            print(f"[clean-pdf] Page {pnum}: dewarped={was_dewarped}", file=sys.stderr)

            _, jpeg_buf = cv2.imencode('.jpg', cleaned,
                                       [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            del cleaned

            new_page = batch_doc.new_page(width=rect.width, height=rect.height)
            new_page.insert_image(rect, stream=jpeg_buf.tobytes())
            del jpeg_buf

        except Exception:
            print(f"[clean-pdf] Page {pnum} failed:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            batch_doc.insert_pdf(doc, from_page=idx, to_page=idx)

        pages_in_batch += 1

        if pages_in_batch >= BATCH_SIZE and pnum < total:
            batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
            batch_doc.save(batch_path, deflate=True)
            batch_doc.close()
            batch_files.append(batch_path)
            batch_doc = fitz.open()
            pages_in_batch = 0
            gc.collect()
            print(f"[clean-pdf] Flushed batch {len(batch_files)} to disk "
                  f"({pnum}/{total})", file=sys.stderr)

    doc.close()

    # Save the last (possibly only) batch
    last_batch = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
    batch_doc.save(last_batch, deflate=True)
    batch_doc.close()
    batch_files.append(last_batch)
    gc.collect()

    print(f"[clean-pdf] Merging {len(batch_files)} batch(es)", file=sys.stderr)
    metadata = {'title': book_name, 'producer': 'Straight Up \u2013 Clean & Dewarp'}
    _merge_batches(batch_files, output_path, metadata)

    write_progress(progress_file, 'done', total, total)
    print("[clean-pdf] Done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python clean_pdf.py <input> <output> <progress_file> [book_name]",
              file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    name = sys.argv[4] if len(sys.argv) > 4 else 'cleaned'

    try:
        process_pdf(inp, out, prog, name)
    except Exception as e:
        print(f"[clean-pdf] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
