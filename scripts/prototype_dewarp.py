"""
Prototype: Page Dewarping Algorithm (v3 - Robust Polynomial Text Line Approach)

Improvements over v2:
- Quadratic polynomial (degree 2) to prevent overfitting at edges
- RANSAC-style outlier filtering for midline points
- Displacement field clamped to text region (no extrapolation beyond margins)
- Better line filtering: residual check, minimum span check
- Smoother field with Gaussian blur instead of uniform filter

Pipeline:
1. Detect text lines via aggressive horizontal dilation + contour detection
2. Fit a quadratic curve to each text line's centerline (with outlier rejection)
3. Estimate a smooth vertical displacement field from the line curvatures
4. Apply cv2.remap to flatten the curves

Saves before/after comparisons to scripts/test_pages/dewarped/
"""

import os
import sys
import time
import cv2
import numpy as np
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(SCRIPT_DIR, "test_pages")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "test_pages", "dewarped")

# --- Tunable parameters ---
DETECT_WIDTH = 1000           # Resize width for detection
MIN_LINE_WIDTH_RATIO = 0.12   # Min line width as fraction of image width
MIN_LINES = 4                 # Minimum text lines to attempt dewarping
DILATION_H = 50               # Horizontal dilation kernel width (merge chars into lines)
DILATION_V = 3                # Vertical dilation kernel height
POLY_DEGREE = 2               # Quadratic: less prone to edge overfitting
MIN_CURVATURE = 1.5           # Minimum curvature (pixels) to warrant dewarping
MAX_FIT_RESIDUAL = 5.0        # Max RMS residual for a line fit (pixels)
MARGIN_FRACTION = 0.03        # Ignore this fraction of width at left/right edges
FIELD_SIGMA_X = 30            # Gaussian smoothing sigma (horizontal) for displacement
FIELD_SIGMA_Y = 15            # Gaussian smoothing sigma (vertical) for displacement


def detect_text_lines(gray):
    """
    Detect text line contours by aggressive horizontal dilation.
    Returns list of dicts with line info.
    """
    h, w = gray.shape

    # Adaptive threshold to find text
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 25, 10
    )

    # Aggressive horizontal dilation to merge characters into full text lines
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (DILATION_H, DILATION_V))
    dilated = cv2.dilate(binary, h_kernel, iterations=2)

    # Close small gaps
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (DILATION_H // 2, 1))
    closed = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, close_kernel)

    # Find contours
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_line_width = w * MIN_LINE_WIDTH_RATIO

    lines = []
    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)

        if cw < min_line_width:
            continue
        if ch > h * 0.08:  # Skip giant blobs
            continue
        if ch < 3:  # Skip hairlines
            continue
        aspect = cw / max(ch, 1)
        if aspect < 2.5:  # Text lines are much wider than tall
            continue
        if y <= 1 or y + ch >= h - 1:
            continue

        # Sample the midline y-coordinate using the original binary image
        midline_points = sample_contour_midline(binary[y:y+ch, x:x+cw], x, y, cw, ch)

        if len(midline_points) >= 8:
            lines.append({
                'bbox': (x, y, cw, ch),
                'center_y': y + ch / 2,
                'midline': midline_points,
            })

    lines.sort(key=lambda l: l['center_y'])
    return lines


def sample_contour_midline(local_binary, x_offset, y_offset, cw, ch):
    """
    Sample the vertical midpoint of text at regular x intervals along a line.
    Uses center-of-mass of ink pixels per column for accuracy.
    """
    points = []
    step = max(2, cw // 40)  # ~40 sample points per line

    for lx in range(step, cw - step, step):  # Skip edges of bounding box
        if lx >= local_binary.shape[1]:
            continue

        col = local_binary[:, lx]
        ink_rows = np.where(col > 0)[0]
        if len(ink_rows) < 2:
            continue

        # Center of mass of ink pixels
        mid_y = float(np.mean(ink_rows)) + y_offset
        abs_x = float(lx + x_offset)
        points.append((abs_x, mid_y))

    return points


def fit_line_curves(lines, img_width, img_height):
    """
    Fit a polynomial to each text line's midline points with outlier rejection.
    """
    fitted_lines = []
    margin = img_width * MARGIN_FRACTION

    for line in lines:
        pts = np.array(line['midline'])
        if len(pts) < 8:
            continue

        xs = pts[:, 0]
        ys = pts[:, 1]

        # Filter out points too close to image edges
        mask = (xs > margin) & (xs < img_width - margin)
        xs = xs[mask]
        ys = ys[mask]

        if len(xs) < 6:
            continue

        # First fit: get coefficients
        try:
            coeffs = np.polyfit(xs, ys, POLY_DEGREE)
            poly = np.poly1d(coeffs)
            fitted_ys = poly(xs)
            residuals = np.abs(ys - fitted_ys)

            # Outlier rejection: remove points with residual > 2 * median
            med_residual = np.median(residuals)
            inlier_mask = residuals < max(med_residual * 3, 2.0)

            if np.sum(inlier_mask) < 6:
                continue

            xs_clean = xs[inlier_mask]
            ys_clean = ys[inlier_mask]

            # Refit on inliers
            coeffs = np.polyfit(xs_clean, ys_clean, POLY_DEGREE)
            poly = np.poly1d(coeffs)
            fitted_ys = poly(xs_clean)

            # Check fit quality
            rms_residual = np.sqrt(np.mean((ys_clean - fitted_ys) ** 2))
            if rms_residual > MAX_FIT_RESIDUAL:
                continue

            # The "ideal" y for this line: mean of the fitted values
            ideal_y = np.mean(fitted_ys)

            # Curvature: max deviation from the straight ideal line
            deviations = fitted_ys - ideal_y
            curvature = np.max(np.abs(deviations))

            fitted_lines.append({
                'xs': xs_clean,
                'ys': ys_clean,
                'fitted_ys': fitted_ys,
                'ideal_y': ideal_y,
                'coeffs': coeffs,
                'poly': poly,
                'curvature': curvature,
                'deviations': deviations,
                'rms_residual': rms_residual,
                'x_min': float(np.min(xs_clean)),
                'x_max': float(np.max(xs_clean)),
                'bbox': line['bbox'],
            })
        except (np.RankWarning, np.linalg.LinAlgError):
            continue

    return fitted_lines


def build_displacement_field(fitted_lines, img_width, img_height):
    """
    Build a smooth vertical displacement field from the fitted text line curves.

    Key improvement: only generate displacements within the actual text region
    (between x_min and x_max of each line), then interpolate smoothly.
    """
    sample_xs = []
    sample_ys = []
    sample_dy = []

    for line in fitted_lines:
        xs = line['xs']
        fitted_ys = line['fitted_ys']
        ideal_y = line['ideal_y']

        for i in range(len(xs)):
            dy = ideal_y - fitted_ys[i]
            sample_xs.append(xs[i])
            sample_ys.append(fitted_ys[i])
            sample_dy.append(dy)

    if len(sample_xs) < 20:
        return None

    sample_xs = np.array(sample_xs)
    sample_ys = np.array(sample_ys)
    sample_dy = np.array(sample_dy)

    # Add anchor points at corners/edges with zero displacement
    # This prevents wild extrapolation outside the text region
    anchors_x = [0, img_width - 1, 0, img_width - 1,
                 img_width // 2, img_width // 2, 0, img_width - 1]
    anchors_y = [0, 0, img_height - 1, img_height - 1,
                 0, img_height - 1, img_height // 2, img_height // 2]
    anchors_dy = [0.0] * len(anchors_x)

    all_xs = np.concatenate([sample_xs, anchors_x])
    all_ys = np.concatenate([sample_ys, anchors_y])
    all_dy = np.concatenate([sample_dy, anchors_dy])

    # Create output grid
    grid_x = np.arange(img_width, dtype=np.float64)
    grid_y = np.arange(img_height, dtype=np.float64)
    gx, gy = np.meshgrid(grid_x, grid_y)

    # Interpolate the displacement field
    try:
        dy_field = griddata(
            np.column_stack([all_xs, all_ys]),
            all_dy,
            (gx, gy),
            method='linear',
            fill_value=0.0
        )
    except Exception:
        return None

    # Fill any remaining NaN values
    nan_mask = np.isnan(dy_field)
    if nan_mask.any():
        try:
            dy_nearest = griddata(
                np.column_stack([all_xs, all_ys]),
                all_dy,
                (gx[nan_mask], gy[nan_mask]),
                method='nearest',
            )
            dy_field[nan_mask] = dy_nearest
        except Exception:
            dy_field[nan_mask] = 0.0

    # Gaussian smoothing for a natural-looking result
    dy_field = gaussian_filter(dy_field, sigma=[FIELD_SIGMA_Y, FIELD_SIGMA_X])

    return dy_field.astype(np.float32)


def dewarp_page(img, debug=False):
    """
    Dewarp a single page image.

    Returns:
        dewarped: dewarped image
        info: dict with dewarping metadata
    """
    t0 = time.time()

    if len(img.shape) == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img.copy()

    h, w = gray.shape

    # Resize for detection
    scale = DETECT_WIDTH / w
    detect_h = int(h * scale)
    detect_gray = cv2.resize(gray, (DETECT_WIDTH, detect_h), interpolation=cv2.INTER_AREA)

    # Step 1: Detect text lines
    lines = detect_text_lines(detect_gray)
    print(f"    Detected {len(lines)} text lines", end="")

    if len(lines) < MIN_LINES:
        print(f" (need {MIN_LINES}+, skipping)")
        return img, {'wasWarped': False, 'reason': f'too few lines ({len(lines)})', 'lines': len(lines)}

    # Step 2: Fit polynomial curves
    fitted_lines = fit_line_curves(lines, DETECT_WIDTH, detect_h)
    print(f", {len(fitted_lines)} fitted", end="")

    if len(fitted_lines) < MIN_LINES:
        print(f" (need {MIN_LINES}+, skipping)")
        return img, {'wasWarped': False, 'reason': f'too few fitted lines ({len(fitted_lines)})', 'fitted': len(fitted_lines)}

    # Check curvature
    max_curvature = max(l['curvature'] for l in fitted_lines)
    avg_curvature = np.mean([l['curvature'] for l in fitted_lines])
    print(f", max_curv={max_curvature:.1f}px, avg_curv={avg_curvature:.1f}px", end="")

    if max_curvature < MIN_CURVATURE:
        print(f" (below {MIN_CURVATURE}px, skipping)")
        return img, {
            'wasWarped': False,
            'reason': 'negligible curvature',
            'max_curvature': max_curvature,
        }

    # Step 3: Build displacement field
    dy_field_small = build_displacement_field(fitted_lines, DETECT_WIDTH, detect_h)

    if dy_field_small is None:
        print(" (interpolation failed)")
        return img, {'wasWarped': False, 'reason': 'interpolation failed'}

    # Step 4: Scale to full resolution and apply
    inv_scale = 1.0 / scale
    dy_field_full = cv2.resize(dy_field_small, (w, h), interpolation=cv2.INTER_LINEAR) * inv_scale

    gx = np.tile(np.arange(w, dtype=np.float32), (h, 1))
    gy = np.tile(np.arange(h, dtype=np.float32).reshape(-1, 1), (1, w))

    map_x = gx
    map_y = gy - dy_field_full

    border_value = (255, 255, 255) if len(img.shape) == 3 else 255
    dewarped = cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=border_value)

    elapsed = time.time() - t0
    print(f" -> DEWARPED in {elapsed:.2f}s")

    return dewarped, {
        'wasWarped': True,
        'max_curvature': float(max_curvature),
        'avg_curvature': float(avg_curvature),
        'num_lines': len(fitted_lines),
        'elapsed_s': elapsed,
    }


def draw_debug_overlay(img, fitted_lines, scale):
    """Draw text line curves on the image for debugging."""
    debug = img.copy()
    inv_scale = 1.0 / scale

    for line in fitted_lines:
        xs = (line['xs'] * inv_scale).astype(int)
        fitted_ys = (line['fitted_ys'] * inv_scale).astype(int)
        ideal_y = int(line['ideal_y'] * inv_scale)

        # Draw the fitted curve (red)
        for i in range(len(xs) - 1):
            cv2.line(debug, (xs[i], fitted_ys[i]), (xs[i+1], fitted_ys[i+1]), (0, 0, 255), 2)

        # Draw the ideal straight line (green)
        if len(xs) > 0:
            cv2.line(debug, (xs[0], ideal_y), (xs[-1], ideal_y), (0, 255, 0), 1)

    return debug


def process_all():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.isdir(INPUT_DIR):
        print(f"Input directory not found: {INPUT_DIR}")
        print("Run extract_test_pages.py first.")
        sys.exit(1)

    all_pngs = sorted([f for f in os.listdir(INPUT_DIR)
                       if f.lower().endswith(".png") and not f.startswith(".")])

    mid_files = [f for f in all_pngs if "mid" in f.lower()]
    other_files = [f for f in all_pngs if "mid" not in f.lower()]
    png_files = mid_files + other_files[:5]

    if not png_files:
        print(f"No PNG files found in {INPUT_DIR}")
        sys.exit(1)

    print(f"Processing {len(png_files)} pages...")
    print(f"Parameters: min_lines={MIN_LINES}, poly_degree={POLY_DEGREE}, "
          f"min_curvature={MIN_CURVATURE}px, max_residual={MAX_FIT_RESIDUAL}px")
    print()

    results = []

    for filename in png_files:
        filepath = os.path.join(INPUT_DIR, filename)
        img = cv2.imread(filepath)
        if img is None:
            print(f"  Failed to read: {filename}")
            continue

        h, w = img.shape[:2]
        print(f"  {filename} ({w}x{h})")

        dewarped, info = dewarp_page(img)

        name, ext = os.path.splitext(filename)
        out_path = os.path.join(OUTPUT_DIR, f"{name}_dewarped{ext}")
        cv2.imwrite(out_path, dewarped)

        # Side-by-side comparison
        gray_orig = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
        gray_dw = cv2.cvtColor(dewarped, cv2.COLOR_BGR2GRAY) if len(dewarped.shape) == 3 else dewarped
        comparison = np.hstack([gray_orig, gray_dw])
        comp_path = os.path.join(OUTPUT_DIR, f"{name}_compare{ext}")
        cv2.imwrite(comp_path, comparison)

        # Debug overlay
        scale = DETECT_WIDTH / w
        detect_h = int(h * scale)
        detect_gray = cv2.resize(
            cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img,
            (DETECT_WIDTH, detect_h)
        )
        lines = detect_text_lines(detect_gray)
        fitted = fit_line_curves(lines, DETECT_WIDTH, detect_h)
        if fitted:
            debug_img = draw_debug_overlay(img, fitted, scale)
            debug_path = os.path.join(OUTPUT_DIR, f"{name}_debug{ext}")
            cv2.imwrite(debug_path, debug_img)

        results.append((filename, info))
        print()

    print("=" * 60)
    print("Summary:")
    dewarped_count = sum(1 for _, info in results if info.get('wasWarped'))
    skipped_count = sum(1 for _, info in results if not info.get('wasWarped'))
    print(f"  Dewarped: {dewarped_count}")
    print(f"  Skipped:  {skipped_count}")
    for fname, info in results:
        status = "DEWARPED" if info.get('wasWarped') else "SKIPPED"
        if info.get('wasWarped'):
            detail = f"max_curv={info['max_curvature']:.1f}px, {info['elapsed_s']:.2f}s"
        else:
            detail = info.get('reason', '')
        print(f"    {fname}: {status} ({detail})")
    print(f"\n  Results in: {OUTPUT_DIR}")


if __name__ == "__main__":
    process_all()
