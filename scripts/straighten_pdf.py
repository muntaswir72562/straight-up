#!/usr/bin/env python3
"""
Straighten (deskew) PDF processing pipeline (server-side).

For each page:
  1. Render at target DPI via pymupdf
  2. Detect skew angle via text line contour analysis
  3. Rotate to straighten + auto-crop
  4. Add to output PDF

Usage:
  python straighten_pdf.py <input.pdf> <output.pdf> <progress_file> [book_name]

Progress is written to <progress_file> as JSON after each page:
  {"phase": "straightening", "current": 5, "total": 50}
"""

import sys
import json
import traceback
import numpy as np
import cv2
import math

try:
    import fitz  # pymupdf
except ImportError:
    print("Error: pymupdf required. Install: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


# ── Constants ────────────────────────────────────────────────────────
RENDER_DPI = 200
DETECT_WIDTH = 1000
JPEG_QUALITY = 92

# Skew detection (text-line based)
MAX_SKEW_ANGLE = 10.0       # max detectable skew (degrees)
MIN_SKEW_ANGLE = 0.15       # below this, don't bother rotating
MIN_SKEW_CONFIDENCE = 1.5   # minimum confidence to accept detection
FINE_STEP = 0.05            # angle rounding precision


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Skew detection ───────────────────────────────────────────────────

def detect_skew_from_text(gray):
    """
    Detect skew by measuring the angle of text lines directly.
    Ignores page borders entirely — only looks at text-shaped contours
    in the interior of the page.
    """
    h, w = gray.shape

    # Binarize
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 10,
    )

    # Dilate horizontally to merge characters into text line blobs
    h_kern = cv2.getStructuringElement(cv2.MORPH_RECT, (50, 3))
    dilated = cv2.dilate(binary, h_kern, iterations=2)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_w = w * 0.15
    margin = int(w * 0.05)
    angles = []

    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        # Must be wide enough to be a text line
        if cw < min_w:
            continue
        # Must have text-line aspect ratio
        if cw / max(ch, 1) < 2.5:
            continue
        # Skip contours touching page edges (borders/shadows)
        if x <= margin or x + cw >= w - margin:
            continue
        if y <= margin or y + ch >= h - margin:
            continue
        # Fit a line through the contour points
        line = cv2.fitLine(cnt, cv2.DIST_L2, 0, 0.01, 0.01)
        vx, vy = float(line[0][0]), float(line[1][0])
        angle_deg = math.degrees(math.atan2(vy, vx))
        # Normalize to small angle from horizontal
        if angle_deg > 45:
            angle_deg -= 90
        elif angle_deg < -45:
            angle_deg += 90
        if abs(angle_deg) <= MAX_SKEW_ANGLE:
            angles.append(angle_deg)

    if len(angles) < 2:
        return 0.0, 0.0

    # Outlier rejection
    med = float(np.median(angles))
    filtered = [a for a in angles if abs(a - med) <= 2.0]
    if len(filtered) < 2:
        return 0.0, 0.0

    angle = float(np.median(filtered))
    confidence = min(len(filtered), 10)

    # Round to precision
    angle = round(angle / FINE_STEP) * FINE_STEP
    angle = round(angle * 1000) / 1000

    # Negate for correction
    return -angle, confidence


# ── Straighten ───────────────────────────────────────────────────────

def straighten_page(gray, angle):
    """Rotate image by angle degrees and auto-crop to page content."""
    h, w = gray.shape[:2]
    is_color = len(gray.shape) == 3

    center = (w / 2, h / 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    border_val = (255, 255, 255) if is_color else 255
    rotated = cv2.warpAffine(gray, M, (w, h),
                             flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=border_val)

    # Auto-crop: find the page content region
    if is_color:
        crop_gray = cv2.cvtColor(rotated, cv2.COLOR_BGR2GRAY)
    else:
        crop_gray = rotated

    _, binary = cv2.threshold(crop_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return rotated

    # Find largest contour bounding rect
    largest = max(contours, key=cv2.contourArea)
    x, y, cw, ch = cv2.boundingRect(largest)

    # Safety: crop area must be 50-99% of image, aspect ratio change ≤ 15%
    crop_area = cw * ch
    img_area = w * h
    ratio = crop_area / img_area
    if ratio < 0.5 or ratio > 0.99:
        return rotated

    orig_aspect = w / max(h, 1)
    crop_aspect = cw / max(ch, 1)
    if abs(crop_aspect - orig_aspect) / orig_aspect > 0.15:
        return rotated

    # Add 1% margin
    margin_x = int(w * 0.01)
    margin_y = int(h * 0.01)
    x = max(0, x - margin_x)
    y = max(0, y - margin_y)
    cw = min(w - x, cw + 2 * margin_x)
    ch = min(h - y, ch + 2 * margin_y)

    return rotated[y:y+ch, x:x+cw]


# ── Main pipeline ────────────────────────────────────────────────────

def process_pdf(input_path, output_path, progress_file, book_name='straightened'):
    print(f"[straighten] Opening {input_path}", file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    print(f"[straighten] {total} pages", file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)
    out_doc = fitz.open()

    for idx in range(total):
        pnum = idx + 1
        write_progress(progress_file, 'straightening', pnum, total)

        page = doc[idx]
        try:
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)

            if pix.n == 4:
                gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            elif pix.n == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img.copy()

            # Detect at reduced resolution
            h, w = gray.shape
            scale = DETECT_WIDTH / w
            dh = int(h * scale)
            small = cv2.resize(gray, (DETECT_WIDTH, dh), interpolation=cv2.INTER_AREA)

            angle, confidence = detect_skew_from_text(small)

            if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                result = straighten_page(gray, angle)
                rh, rw = result.shape[:2]
                print(f"[straighten] Page {pnum}/{total}: angle={angle:.2f}° conf={confidence:.1f} "
                      f"({rw}x{rh})", file=sys.stderr)

                _, jpeg_buf = cv2.imencode('.jpg', result,
                                           [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                rect = page.rect
                new_page = out_doc.new_page(width=rect.width, height=rect.height)
                new_page.insert_image(rect, stream=jpeg_buf.tobytes())
            else:
                print(f"[straighten] Page {pnum}/{total}: angle={angle:.2f}° conf={confidence:.1f} "
                      f"— skipping (below threshold)", file=sys.stderr)
                out_doc.insert_pdf(doc, from_page=idx, to_page=idx)

        except Exception:
            print(f"[straighten] Page {pnum} failed:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            out_doc.insert_pdf(doc, from_page=idx, to_page=idx)

    out_doc.set_metadata({'title': book_name, 'producer': 'Straight Up – Straighten'})

    print(f"[straighten] Saving to {output_path}", file=sys.stderr)
    out_doc.save(output_path, deflate=True, garbage=3)
    out_doc.close()
    doc.close()

    write_progress(progress_file, 'done', total, total)
    print("[straighten] Done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python straighten_pdf.py <input> <output> <progress_file> [book_name]",
              file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    name = sys.argv[4] if len(sys.argv) > 4 else 'straightened'

    try:
        process_pdf(inp, out, prog, name)
    except Exception as e:
        print(f"[straighten] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
