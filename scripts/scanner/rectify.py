"""
Perspective rectification.

A plain 4-point warp using "average side length" gets the aspect ratio wrong
when the phone is tilted (pages come out squashed/stretched). Scanner apps
recover the real ratio from the camera model. We use Zhang & He's method
("Whiteboard scanning and image enhancement", 2007): estimate the focal
length from the quad's vanishing geometry, then the true width/height ratio.
"""
from __future__ import annotations

import math

import cv2
import numpy as np


def ratio_with_focal(corners: np.ndarray, img_w: int, img_h: int, f: float) -> float:
    """Width/height of the physical rectangle given a known focal length (px)."""
    src = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float64)
    Hm = cv2.getPerspectiveTransform(src.astype(np.float32), corners.astype(np.float32)).astype(np.float64)
    K = np.array([[f, 0, img_w / 2.0], [0, f, img_h / 2.0], [0, 0, 1]])
    Ki = np.linalg.inv(K)
    r1, r2 = Ki @ Hm[:, 0], Ki @ Hm[:, 1]  # scaled rotation columns = width, height directions
    return float(np.linalg.norm(r1) / np.linalg.norm(r2))


# typical phone main camera (~26 mm equiv.) => f ~ 0.8 x long side in pixels
DEFAULT_FOCAL_FACTOR = 0.8


def true_aspect_ratio(corners: np.ndarray, img_w: int, img_h: int) -> float:
    tl, tr, br, bl = corners.astype(np.float64)
    top, bottom = np.linalg.norm(tr - tl), np.linalg.norm(br - bl)
    left, right = np.linalg.norm(bl - tl), np.linalg.norm(br - tr)
    naive = max(top, bottom) / max(left, right, 1e-6)
    f_default = DEFAULT_FOCAL_FACTOR * max(img_w, img_h)

    def fallback():
        # one pair of sides parallel (e.g. phone tilted straight forward): the
        # focal length can't be solved from the quad, so assume a phone lens
        r = ratio_with_focal(corners, img_w, img_h, f_default)
        return r if 0.2 < r < 5 else naive

    u0, v0 = img_w / 2.0, img_h / 2.0
    m1, m2, m3, m4 = (np.array([p[0], p[1], 1.0]) for p in (tl, tr, bl, br))
    try:
        k2 = np.dot(np.cross(m1, m4), m3) / np.dot(np.cross(m2, m4), m3)
        k3 = np.dot(np.cross(m1, m4), m2) / np.dot(np.cross(m3, m4), m2)
        n2 = k2 * m2 - m1
        n3 = k3 * m3 - m1
        n21, n22, n23 = n2
        n31, n32, n33 = n3
        if abs(n23 * n33) < 1e-6:
            return fallback()
        f2 = -((n21 * n31 - (n21 * n33 + n23 * n31) * u0 + n23 * n33 * u0 * u0)
               + (n22 * n32 - (n22 * n33 + n23 * n32) * v0 + n23 * n33 * v0 * v0)) / (n23 * n33)
        if f2 <= 0:
            return fallback()
        f = math.sqrt(f2)
        # an implausible focal length means the quad is too close to degenerate
        if not (0.3 * max(img_w, img_h) < f < 4 * max(img_w, img_h)):
            return fallback()
        r = ratio_with_focal(corners, img_w, img_h, f)
        return r if 0.2 < r < 5 else fallback()
    except (ZeroDivisionError, FloatingPointError, np.linalg.LinAlgError):
        return fallback()


def rectify(img: np.ndarray, corners: np.ndarray, max_side: int = 3000) -> np.ndarray:
    h, w = img.shape[:2]
    tl, tr, br, bl = corners
    ratio = true_aspect_ratio(corners, w, h)
    # keep roughly the resolution the page had in the photo
    out_w = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    out_h = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    if out_w / ratio > out_h:
        out_h = out_w / ratio
    else:
        out_w = out_h * ratio
    s = min(1.0, max_side / max(out_w, out_h))
    out_w, out_h = int(round(out_w * s)), int(round(out_h * s))
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], np.float32)
    M = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    return cv2.warpPerspective(img, M, (out_w, out_h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
