"""
Scanner v2 pipeline wrapper for fullfix_pdf.py integration.

Applies: detect -> rectify -> dewarp -> align_columns
to a single page image (grayscale numpy array from the existing pipeline).

Each step has built-in auto-skip logic:
  - detect: returns None when confidence < 0.35 (typical for book scans)
  - rectify: skipped when no detection
  - dewarp: skipped when <4 text lines or page already straight
  - align_columns: skipped when not enough text lines
"""
import sys

import cv2
import numpy as np
from scipy import ndimage

from .detect import detect_document
from .rectify import rectify
from .dewarp import dewarp
from .layout import align_columns
from straighten_pdf import (
    detect_skew_from_text, straighten_page,
    DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE,
)


SKEW_INK = 0.4  # skew from dark print only (0 = off): see _skew_angle


def _skew_angle(gray: np.ndarray, max_deg: float = 6.0):
    """Skew of the text in degrees, in cv2.getRotationMatrix2D's convention
    (so straighten with -angle), or None if there's too little text. Projection profile: rotate the ink pixels and pick the angle whose
    row histogram is sharpest (text rows = tall peaks, gaps = empty). Works
    with a single text line, needs no line detection."""
    h, w = gray.shape
    s = min(1.0, 1000 / max(h, w))
    small = cv2.resize(gray, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    binv = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    binv = cv2.morphologyEx(binv, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))  # specks
    m = 0.03  # ignore a band along the photo border (page edges, shadows)
    hh, ww = binv.shape
    binv[:int(m * hh)], binv[-int(m * hh):], binv[:, :int(m * ww)], binv[:, -int(m * ww):] = 0, 0, 0, 0
    if SKEW_INK > 0:
        # Use printed text only: a library stamp, pencil notes or show-through
        # from the back of the sheet are much lighter than print, and a tilted
        # stamp (box lines, dotted fields) can outweigh a few short text rows.
        # Keep blobs whose darkest pixel is near the darkest ink on the page.
        bg = cv2.medianBlur(cv2.dilate(small, np.ones((7, 7), np.uint8)), 31)
        norm = cv2.divide(small, bg, scale=255)
        n, lab, st, _ = cv2.connectedComponentsWithStats(binv, 8)
        if n > 1:
            dmin = ndimage.minimum(norm, lab, np.arange(1, n))
            big = st[1:, 4] >= 10
            if big.sum() >= 20:
                ink = float(np.percentile(dmin[big], 10))
                dark = dmin <= ink + SKEW_INK * (255.0 - ink)
                lut = np.zeros(n, np.uint8)
                lut[1:][dark] = 255
                kept = lut[lab]
                if np.count_nonzero(kept) >= 500:
                    binv = kept
    ys, xs = np.nonzero(binv)
    if len(xs) < 500:
        return None
    if len(xs) > 200000:
        k = np.random.default_rng(0).choice(len(xs), 200000, replace=False)
        ys, xs = ys[k], xs[k]
    xs = xs - ww / 2.0
    ys = ys - hh / 2.0
    nb = int(np.hypot(hh, ww)) + 2

    def score(a):
        t = np.deg2rad(a)
        yr = ys * np.cos(t) + xs * np.sin(t)
        hist = np.bincount((yr + nb / 2).astype(int), minlength=nb).astype(np.float64)
        return float((hist ** 2).sum())

    coarse = np.arange(-max_deg, max_deg + 1e-9, 0.25)
    sc = np.array([score(a) for a in coarse])
    a0 = coarse[int(np.argmax(sc))]
    fine = np.arange(a0 - 0.25, a0 + 0.25 + 1e-9, 0.02)
    a1 = float(fine[int(np.argmax([score(a) for a in fine]))])
    # must be clearly sharper than neighbours, otherwise no text structure
    if sc.max() < 1.05 * np.median(sc):
        return None
    return a1


def process_page_v2(gray: np.ndarray, page_num: int = 0, total: int = 0) -> np.ndarray:
    """
    Run the scanner v2 pipeline on a single grayscale page.

    Args:
        gray: Grayscale numpy array (H, W), uint8
        page_num: Page number for logging
        total: Total pages for logging

    Returns:
        Processed grayscale numpy array
    """
    tag = f"[fullfix-v2] Page {page_num}/{total}"

    # Scanner modules expect BGR (3-channel) input
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # Step 1: Document boundary detection
    det = detect_document(bgr)

    if det is not None:
        print(f"{tag}: detect={det.method} conf={det.confidence:.2f}", file=sys.stderr)
        # Step 2: Perspective rectification (Zhang & He true aspect ratio)
        bgr = rectify(bgr, det.corners)
        print(f"{tag}: rectified", file=sys.stderr)
    else:
        print(f"{tag}: no document boundary detected, skipping rectify", file=sys.stderr)

    # Step 3: Polynomial text-line dewarping
    bgr, dinfo = dewarp(bgr)
    if dinfo.applied:
        print(f"{tag}: dewarped ({dinfo.lines} lines, bend={dinfo.before_px:.1f}px)", file=sys.stderr)
    else:
        print(f"{tag}: dewarp skipped ({dinfo.reason})", file=sys.stderr)
        # Fallback: dewarp couldn't run (too little text, unreliable fit):
        # still remove the skew, so v2 never loses straightening. Projection
        # profile estimator (_skew_angle), not straighten_pdf's
        # detect_skew_from_text, which over/under-estimates (3.0 deg -> 2.1,
        # 0 deg -> 1.1 on a 4-line contents page) and whose straighten_page crops.
        if dinfo.reason != "page already straight":
            angle = _skew_angle(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
            if angle is not None and abs(angle) >= 0.1:
                h, w = bgr.shape[:2]
                M = cv2.getRotationMatrix2D((w / 2, h / 2), -angle, 1.0)
                bgr = cv2.warpAffine(bgr, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                print(f"{tag}: fallback deskew {angle:.2f} deg", file=sys.stderr)

    # Step 4: RANSAC column alignment
    bgr, ainfo = align_columns(bgr)
    if ainfo.applied:
        print(f"{tag}: columns aligned (L={ainfo.left_shift_px:.1f}px, R={ainfo.right_shift_px:.1f}px)",
              file=sys.stderr)
    else:
        print(f"{tag}: align skipped ({ainfo.reason})", file=sys.stderr)

    # Convert back to grayscale
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
