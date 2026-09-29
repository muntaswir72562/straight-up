"""
Text-block alignment and page framing.

After perspective + curl correction the text lines are horizontal, but the
column itself can still be slanted or bowed: the left margin gets wider (or
narrower) from top to bottom, and the photo's crop leaves uneven white space.
Scanner apps finish with two steps, done here:

  1. align_columns: find where each text line starts and ends, robustly fit
     the left and right column edges as functions of y (RANSAC, so indented
     paragraph starts, headings and short last lines are ignored), then shift
     and stretch every row so both edges become perfectly vertical.
  2. text_box + frame: locate the text block and re-frame the page so the
     block is centred with the same margin on every side.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Lines:
    xh: float            # typical character height (px, full res)
    boxes: np.ndarray    # (n, 4) x, y, w, h of text lines (full res)
    chars: np.ndarray    # (m, 4) x, y, w, h of character blobs (full res)
    rules: np.ndarray    # (k, 4) horizontal rules (header/footer lines, table rules)
    edge_chars: np.ndarray = None  # char-sized blobs cut by the photo border (kept, never used for layout)


def find_lines(img: np.ndarray, work_side: int = 1600) -> Lines | None:
    H, W = img.shape[:2]
    s = min(2.5, work_side / max(H, W))
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    h, w = gray.shape

    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), 31)
    norm = cv2.divide(gray, bg, scale=255)
    block = max(15, (min(h, w) // 40) | 1)
    binv = cv2.adaptiveThreshold(norm, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 15)

    n, lab, st, _ = cv2.connectedComponentsWithStats(binv, 8)
    x, y, bw, bh, area = (st[1:, i] for i in range(5))
    cand = (bh > 3) & (bh < 0.06 * h) & (bw < 0.1 * w) & (area > 6)
    # ignore blobs touching the image border (page edges, shadows, fingers)
    edge = 2
    inside = (x > edge) & (y > edge) & (x + bw < w - edge) & (y + bh < h - edge)
    cand &= inside
    if cand.sum() < 30:
        return None
    xh = float(np.median(bh[cand]))
    keep = cand & (bh < 2.5 * xh) & (bh > 0.35 * xh)
    lut = np.zeros(n, np.uint8)
    lut[1:][keep] = 255
    chars = lut[lab]

    kx = max(3, int(round(2.0 * xh)))
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 1))
    lines = cv2.morphologyEx(chars, cv2.MORPH_CLOSE, k)
    n2, _, st2, _ = cv2.connectedComponentsWithStats(lines, 8)
    boxes = st2[1:, :4]
    thick = st2[1:, 4] / np.maximum(st2[1:, 2], 1)
    ok = (boxes[:, 2] > 3 * xh) & (thick < 2.2 * xh) & (thick > 0.3 * xh)
    cb = np.stack([x, y, bw, bh], 1)[keep]
    # long thin horizontal strokes = rules; keep them as part of the page
    # (use mean stroke thickness, not bbox height: a slightly tilted rule has a tall bbox)
    is_rule = inside & (bw > 0.2 * w) & (area / np.maximum(bw, 1) < max(3, 0.6 * xh)) & (bh < 3 * xh)
    rb = np.stack([x, y, bw, bh], 1)[is_rule]
    sized = (bh < 2.5 * xh) & (bw < 3 * xh) & (area > 6)
    eb = np.stack([x, y, bw, bh], 1)[sized & ~inside]
    return Lines(xh / s, boxes[ok] / s, cb / s, rb / s, eb / s)


def _fit_edge(ys: np.ndarray, xs: np.ndarray, tol: float, min_inliers: int):
    """Robust x = f(y) through the points that sit ON the column edge."""
    n = len(ys)
    if n < min_inliers:
        return None
    # vectorised RANSAC over all point pairs (n is small: one point per text line)
    I, J = np.triu_indices(n, 1)
    dy = ys[J] - ys[I]
    ok = np.abs(dy) > 1e-3
    I, J, dy = I[ok], J[ok], dy[ok]
    b = (xs[J] - xs[I]) / dy
    ok = np.abs(b) < 0.2
    I, b = I[ok], b[ok]
    if len(b) == 0:
        return None
    a = xs[I] - b * ys[I]
    r = np.abs(xs[None, :] - (a[:, None] + b[:, None] * ys[None, :]))
    inl = r < tol
    cnt = inl.sum(1)
    err = np.where(inl, r, 0).sum(1)
    k = np.lexsort((err, -cnt))[0]  # most inliers, then smallest error
    best, best_cnt = inl[k], int(cnt[k])
    if best_cnt < min_inliers:
        return None
    yi, xi = ys[best], xs[best]
    p = np.polyfit(yi, xi, 1)
    # allow a gentle bow (curl residue) when there is enough support for it
    if best_cnt >= 10:
        p2 = np.polyfit(yi, xi, 2)
        r1 = np.sqrt(np.mean((xi - np.polyval(p, yi)) ** 2))
        r2 = np.sqrt(np.mean((xi - np.polyval(p2, yi)) ** 2))
        if r2 < 0.7 * r1:
            p = p2
    return p, (float(yi.min()), float(yi.max())), best_cnt


@dataclass
class AlignInfo:
    applied: bool
    reason: str
    left_shift_px: float = 0.0   # max correction applied at the left edge
    right_shift_px: float = 0.0


def align_columns(img: np.ndarray, lines: Lines | None = None) -> tuple[np.ndarray, AlignInfo]:
    H, W = img.shape[:2]
    lines = lines or find_lines(img)
    if lines is None or len(lines.boxes) < 5:
        return img, AlignInfo(False, "not enough text lines")
    b = lines.boxes.astype(np.float64)
    long_ = b[:, 2] > 0.3 * W  # body-text lines only
    b = b[long_]
    if len(b) < 5:
        return img, AlignInfo(False, "not enough long lines")
    yc = b[:, 1] + b[:, 3] / 2
    left, right = b[:, 0], b[:, 0] + b[:, 2]
    tol = 0.6 * lines.xh
    # an edge only counts if a clear majority of lines sit on it. Tables of
    # contents, forms and ragged-right text have no real right edge, and
    # "straightening" a fake one stretches and cuts rows.
    fl = _fit_edge(yc, left, tol, max(5, int(0.4 * len(b))))
    if fl is None:
        return img, AlignInfo(False, "no consistent left margin")
    fr = _fit_edge(yc, right, tol, max(6, int(0.5 * len(b))))

    y0, y1 = fl[1]
    ys = np.clip(np.arange(H, dtype=np.float64), y0, y1)  # never extrapolate the fit
    xl = np.polyval(fl[0], ys)
    if fr is not None:
        r0, r1 = fr[1]
        xr = np.polyval(fr[0], np.clip(np.arange(H, dtype=np.float64), r0, r1))
    else:
        # ragged-right text: only remove the slant, keep each row's width
        xr = xl + float(np.median(right - left))
    L, R = float(np.median(xl)), float(np.median(xr))
    dl, dr = float(np.abs(xl - L).max()), float(np.abs(xr - R).max())
    if max(dl, dr) < 0.25 * lines.xh:
        return img, AlignInfo(False, "column already straight", dl, dr)
    scale = (xr - xl) / max(R - L, 1)
    if np.any(scale < 0.8) or np.any(scale > 1.25):
        return img, AlignInfo(False, "margin fit implausible", dl, dr)

    X = np.arange(W, dtype=np.float32)[None, :]
    map_x = (xl[:, None] + (X - L) * scale[:, None]).astype(np.float32)
    map_y = np.repeat(np.arange(H, dtype=np.float32)[:, None], W, axis=1)
    out = cv2.remap(img, map_x, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return out, AlignInfo(True, "ok", dl, dr)


def text_box(img: np.ndarray, lines: Lines | None = None):
    """Bounding box (x0, y0, x1, y1) of the text block, or None."""
    lines = lines or find_lines(img)
    if lines is None or len(lines.boxes) < 3:
        return None
    H, W = img.shape[:2]
    b = lines.boxes
    long_ = b[b[:, 2] > 0.3 * W]
    core = long_ if len(long_) >= 3 else b
    x0, y0 = core[:, 0].min(), core[:, 1].min()
    x1, y1 = (core[:, 0] + core[:, 2]).max(), (core[:, 1] + core[:, 3]).max()
    # grow to include page furniture near the block (running header, page
    # number, header/footer rules, short lines), repeating until stable so
    # chains like "rule -> footer" are picked up; isolated specks stay out
    reach = max(6 * lines.xh, 0.05 * max(H, W))
    items = [e for e in (b, lines.chars, lines.rules) if len(e)]
    items = np.concatenate(items) if items else np.zeros((0, 4))
    changed = True
    while changed:
        changed = False
        for bx, by, bw, bh in items:
            if bx >= x0 and by >= y0 and bx + bw <= x1 and by + bh <= y1:
                continue
            if bx < x1 + reach and bx + bw > x0 - reach and by < y1 + reach and by + bh > y0 - reach:
                x0, y0 = min(x0, bx), min(y0, by)
                x1, y1 = max(x1, bx + bw), max(y1, by + bh)
                changed = True
    return int(x0), int(y0), int(np.ceil(x1)), int(np.ceil(y1))


def frame(img: np.ndarray, box, margin: float = 0.08, lines: Lines | None = None) -> np.ndarray:
    """Crop to the text block and add the same margin on all four sides."""
    x0, y0, x1, y1 = box
    crop = img[y0:y1, x0:x1].copy()
    m = int(round(margin * (x1 - x0)))
    # pad with the paper colour (pure white after enhancement)
    flat = crop.reshape(-1, crop.shape[2]) if crop.ndim == 3 else crop.reshape(-1, 1)
    lum = flat.mean(axis=1)
    paper = np.median(flat[lum >= np.percentile(lum, 60)], axis=0)
    color = tuple(int(v) for v in np.atleast_1d(paper))
    if lines is not None:
        # wipe shadows / page-edge slivers along the crop border that are not text
        h, w = crop.shape[:2]
        pad = max(2, int(0.5 * lines.xh))
        keep = np.zeros((h, w), np.uint8)
        protect = [e for e in (lines.chars, lines.rules, lines.edge_chars) if e is not None and len(e)]
        for bx, by, bw, bh in np.concatenate(protect):
            cv2.rectangle(keep, (int(bx - x0 - pad), int(by - y0 - pad)),
                          (int(bx - x0 + bw + pad), int(by - y0 + bh + pad)), 255, -1)
        band_w = max(3, int(3 * lines.xh))
        band = np.zeros((h, w), bool)
        band[:band_w], band[-band_w:], band[:, :band_w], band[:, -band_w:] = True, True, True, True
        crop[band & (keep == 0)] = color if crop.ndim == 3 else color[0]
    return cv2.copyMakeBorder(crop, m, m, m, m, cv2.BORDER_CONSTANT,
                              value=color if crop.ndim == 3 else color[0])
