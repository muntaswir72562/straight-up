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

from .detect import detect_document
from .rectify import rectify
from .dewarp import dewarp
from .layout import align_columns
from straighten_pdf import (
    detect_skew_from_text, straighten_page,
    DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE,
)


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
        # Fallback: if dewarp couldn't run (not enough lines, fit not reliable)
        # but the page isn't already straight, try legacy deskew
        if dinfo.reason != "page already straight":
            fall_gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
            fh, fw = fall_gray.shape
            scale = DETECT_WIDTH / fw
            small = cv2.resize(fall_gray, (DETECT_WIDTH, int(fh * scale)), interpolation=cv2.INTER_AREA)
            angle, confidence = detect_skew_from_text(small)
            if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                fall_gray = straighten_page(fall_gray, angle)
                bgr = cv2.cvtColor(fall_gray, cv2.COLOR_GRAY2BGR)
                print(f"{tag}: fallback deskew {angle:.2f}° (conf={confidence:.1f})", file=sys.stderr)

    # Step 4: RANSAC column alignment
    bgr, ainfo = align_columns(bgr)
    if ainfo.applied:
        print(f"{tag}: columns aligned (L={ainfo.left_shift_px:.1f}px, R={ainfo.right_shift_px:.1f}px)",
              file=sys.stderr)
    else:
        print(f"{tag}: align skipped ({ainfo.reason})", file=sys.stderr)

    # Convert back to grayscale
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
