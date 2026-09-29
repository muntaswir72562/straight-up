"""
Page-curl dewarping (the "straighten the page" step for book pages).

A homography can only fix a flat page. Book pages curl near the spine, so
text lines come out bent (like the right side of a thick book page). Scanner
apps and research methods (Zucker's "cubic sheet" model, Leptonica's
dewarping, ML models like DocTr/UVDoc) all use the same signal: text lines
are straight on the real page, so their curvature in the photo measures the
warp.

This implementation (Leptonica-style, fast, dependency-light):
  1. Binarise, keep character-sized blobs, estimate the text x-height.
  2. Smear characters horizontally into text-line blobs.
  3. Trace each line's centre curve and fit a low-order polynomial.
  4. Fit ONE smooth 2D polynomial field  src_y = t + P(x, t)  so that every
     traced line maps to a horizontal row t (this also removes skew).
  5. Evaluate the field on a coarse grid, upsample, cv2.remap.
If there aren't enough reliable lines, or the page is already straight,
the image is returned untouched.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

DEG_X, DEG_T = 4, 3
RIDGE = 1e-3


@dataclass
class DewarpInfo:
    applied: bool
    lines: int = 0
    before_px: float = 0.0  # mean line bend (px, work scale) before
    after_px: float = 0.0   # residual after fitting
    reason: str = ""
    debug_lines: list = field(default_factory=list)


def _basis(xn: np.ndarray, tn: np.ndarray) -> np.ndarray:
    cols = [xn ** a * tn ** b for a in range(DEG_X + 1) for b in range(DEG_T + 1)]
    return np.stack(cols, axis=-1)


def _find_text_lines(gray: np.ndarray):
    h, w = gray.shape
    # flatten illumination so a single adaptive threshold works everywhere
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), 31)
    norm = cv2.divide(gray, bg, scale=255)
    block = max(15, (min(h, w) // 40) | 1)
    binv = cv2.adaptiveThreshold(norm, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, block, 15)

    n, lab, stats, _ = cv2.connectedComponentsWithStats(binv, 8)
    hs = stats[1:, cv2.CC_STAT_HEIGHT]
    ws = stats[1:, cv2.CC_STAT_WIDTH]
    areas = stats[1:, cv2.CC_STAT_AREA]
    cand = (hs > 3) & (hs < 0.06 * h) & (ws < 0.1 * w) & (areas > 6)
    if cand.sum() < 30:
        return None, None
    xh = float(np.median(hs[cand]))  # typical character height

    keep = np.zeros(n, bool)
    keep[1:] = cand & (hs < 2.5 * xh) & (hs > 0.35 * xh)
    chars = (keep[lab]).astype(np.uint8) * 255

    # join characters/words into lines, without merging neighbouring lines
    kx = max(3, int(round(2.0 * xh)))
    lines = cv2.morphologyEx(chars, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 1)))
    lines = cv2.morphologyEx(lines, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 1)))

    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(lines, 8)
    traced = []
    step = max(2, int(xh / 2))
    for i in range(1, n2):
        x, y, bw, bh, area = st2[i]
        if bw < 0.15 * w:
            continue
        thickness = area / bw
        if thickness > 2.2 * xh or thickness < 0.3 * xh:
            continue
        sub = (lab2[y:y + bh, x:x + bw] == i)
        cols = np.arange(0, bw, step)
        xs, ys = [], []
        rows = np.arange(bh)[:, None]
        for cx in cols:
            c = sub[:, cx:cx + step]
            cnt = c.sum()
            if cnt < 0.3 * xh:
                continue
            ys.append(y + float((c * rows).sum()) / cnt)
            xs.append(x + cx + step / 2)
        if len(xs) < 8:
            continue
        xs, ys = np.array(xs), np.array(ys)
        deg = 3 if bw > 0.4 * w else 2
        p = np.polyfit(xs, ys, deg)
        res = ys - np.polyval(p, xs)
        good = np.abs(res) < 2.5 * max(res.std(), 0.5)  # drop descender/ascender outliers
        if good.sum() < 8:
            continue
        p = np.polyfit(xs[good], ys[good], deg)
        rms = float(np.sqrt(np.mean((ys[good] - np.polyval(p, xs[good])) ** 2)))
        if rms > 0.45 * xh:
            continue
        xf = np.linspace(xs.min(), xs.max(), 40)
        traced.append((xf, np.polyval(p, xf)))
    return traced, xh


def dewarp(img: np.ndarray, work_side: int = 1600) -> tuple[np.ndarray, DewarpInfo]:
    H, W = img.shape[:2]
    s = min(2.5, work_side / max(H, W))
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    h, w = gray.shape

    traced, xh = _find_text_lines(gray)
    if not traced or len(traced) < 4:
        return img, DewarpInfo(False, len(traced or []), reason="not enough text lines")

    # targets: each line becomes the horizontal row at its mean height
    X, T, Y = [], [], []
    bends = []
    for xf, yf in traced:
        t = float(yf.mean())
        X.append(xf); T.append(np.full_like(xf, t)); Y.append(yf)
        bends.append(float(np.abs(yf - t).max()))
    X, T, Y = np.concatenate(X), np.concatenate(T), np.concatenate(Y)

    x0, x1 = X.min(), X.max()
    t0, t1 = T.min(), T.max()
    nx = lambda x: 2 * (x - x0) / max(x1 - x0, 1) - 1
    nt = lambda t: 2 * (t - t0) / max(t1 - t0, 1) - 1

    A = _basis(nx(X), nt(T))
    b = Y - T
    coef = np.linalg.solve(A.T @ A + RIDGE * len(b) * np.eye(A.shape[1]), A.T @ b)
    resid = b - A @ coef
    before = float(np.mean(bends))
    after = float(np.sqrt(np.mean(resid ** 2)))

    info = DewarpInfo(True, len(traced), before / s, after / s,
                      debug_lines=[(xf / s, yf / s) for xf, yf in traced])
    if before < 0.35 * xh:
        info.applied, info.reason = False, "page already straight"
        return img, info
    if after > 0.6 * before:
        info.applied, info.reason = False, "fit not reliable"
        return img, info

    # evaluate displacement on a coarse grid, clamping to the fitted region
    # so the polynomial never extrapolates wildly into the margins
    g = 8
    gx = np.arange(0, w + g, g, dtype=np.float64)
    gt = np.arange(0, h + g, g, dtype=np.float64)
    GX, GT = np.meshgrid(gx, gt)
    xc = np.clip(nx(GX), -1, 1)
    tc = np.clip(nt(GT), -1.1, 1.1)
    disp = _basis(xc, tc) @ coef  # (len(gt), len(gx)), work-scale pixels

    disp_full = cv2.resize((disp / s).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    # resize() maps grid corners to pixel corners; the grid is slightly larger
    # than the image (by < g px), which is negligible for a smooth field
    map_x, map_y = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    map_y = map_y + disp_full
    out = cv2.remap(img, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    info.reason = "ok"
    return out, info
