"""
Page-curl dewarping (the "straighten the page" step for book pages).

A homography can only fix a flat page. Book pages curl near the spine and
the outer edge, so text lines come out bent. Scanner apps and research
methods (Zucker's "cubic sheet" model, Leptonica's dewarping, ML models like
DocTr/UVDoc) all use the same signal: text lines are straight on the real
page, so their curvature in the photo measures the warp.

This implementation (Leptonica-style, fast, dependency-light):
  1. Binarise, keep character-sized blobs, estimate the text height.
  2. Smear characters horizontally into text-line blobs.
  3. Trace each line along its BASELINE: the bottoms of x-height letters
     (a, e, n, o ...), sampled every ~2 letter heights right to the last word.
     Baselines ignore accents (é, ô), capitals and descenders, so a lift of a
     couple of pixels at the end of a line is measured, not averaged away.
  4. Fit ONE smooth 2D field  src_y = t + D(x, t)  that maps every traced
     baseline to a horizontal row t (this also removes skew). D uses cubic
     B-splines across the page width (so it can bend sharply near the page
     edges, where curl is strongest) x a cubic polynomial down the page,
     with a smoothness penalty. Every line is levelled against the SAME
     reference x (joint solve for the field and each line's row), which is
     what lets strongly tilted bottom lines come out flat.
  5. Evaluate the field on a coarse grid, interpolate, cv2.remap.
If there aren't enough reliable lines, or the page is already straight,
the image is returned untouched.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.interpolate import BSpline, RectBivariateSpline

X_INTERVALS = 10   # B-spline intervals across the text width (even spacing)
T_DEG = 3          # down the page: cubic polynomial (smooth; a flexible spline here follows
                   # line-to-line noise and makes lines bow). 0 = use B-splines instead.
T_LINES_PER_INTERVAL = 3  # only used when T_DEG = 0
T_MIN, T_MAX = 3, 12
SMOOTH = 0.05      # second-difference penalty (relative)
USE_PREFIX = True  # sample article numbers / list markers at line starts (see _trace_baselines)
EXTRAP_X = 6.0     # continue the field past the traced span along its edge slope for up to this many letter heights (0 = hold flat)
OUTLIER = 0.65     # drop a glyph whose bottom is this many letter heights off its neighbours (raised "°", footnote marks)


@dataclass
class DewarpInfo:
    applied: bool
    lines: int = 0
    before_px: float = 0.0  # 90th-percentile line bend before (px, full res)
    after_px: float = 0.0   # rms residual after fitting (px, full res)
    reason: str = ""
    debug_lines: list = field(default_factory=list)


def _binarize(gray: np.ndarray) -> np.ndarray:
    h, w = gray.shape
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), 31)
    norm = cv2.divide(gray, bg, scale=255)
    block = max(15, (min(h, w) // 40) | 1)
    return cv2.adaptiveThreshold(norm, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, block, 15)


def _trace_baselines(gray: np.ndarray):
    """Return ([(xs, ys), ...] baseline samples per text line, char height)."""
    h, w = gray.shape
    binv = _binarize(gray)
    n, lab, st, cent = cv2.connectedComponentsWithStats(binv, 8)
    x, y, bw, bh, area = (st[1:, i] for i in range(5))
    cand = (bh > 3) & (bh < 0.06 * h) & (bw < 0.1 * w) & (area > 6)
    cand &= (x > 2) & (y > 2) & (x + bw < w - 2) & (y + bh < h - 2)
    if cand.sum() < 30:
        return None, None
    xh = float(np.median(bh[cand]))
    keep = cand & (bh < 2.5 * xh) & (bh > 0.35 * xh)

    lut = np.zeros(n, np.uint8)
    lut[1:][keep] = 255
    chars = lut[lab]
    kx = max(3, int(round(2.0 * xh)))
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 1))
    lines = cv2.morphologyEx(chars, cv2.MORPH_CLOSE, k)
    lines = cv2.morphologyEx(lines, cv2.MORPH_OPEN, k)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(lines, 8)

    # assign each character to the line blob under its centre
    idx = np.nonzero(keep)[0]
    cx = np.clip(cent[1:, 0][idx].round().astype(int), 0, w - 1)
    cy = np.clip(cent[1:, 1][idx].round().astype(int), 0, h - 1)
    line_of = lab2[cy, cx]
    bottoms = (y + bh)[idx].astype(np.float64)
    centres = (x + bw / 2.0)[idx]
    heights = bh[idx]
    # x-height letters only: no ascenders/capitals (taller), no commas/dots
    # (shorter); accents are separate small blobs and already excluded
    xl = (heights > 0.55 * xh) & (heights < 1.25 * xh)

    step = 2.0 * xh
    traced = []
    for i in range(1, n2):
        lx, ly, lw, lh, la = st2[i]
        if lw < 0.15 * w:
            continue
        thick = la / lw
        if thick > 2.2 * xh or thick < 0.3 * xh:
            continue
        m = (line_of == i) & xl
        if m.sum() < 8:
            continue
        cxs, bys = centres[m], bottoms[m]
        # Line-start prefix (article numbers "2125.", list markers): digits are
        # taller than x-height so never sampled above, yet they sit on the
        # baseline. Use them only BEFORE the line's first x-height glyph, and
        # only if >= 3 of them agree on a bottom line, so a stray capital or
        # descender can't get in. This anchors the field at the far left, where
        # a curl is often steepest.
        pre = None
        if USE_PREFIX:
            tall = (line_of == i) & (heights >= 1.25 * xh) & (heights < 1.9 * xh)
            tx, ty = centres[tall], bottoms[tall]
            sel = tx < cxs.min() - 0.3 * xh
            if sel.sum() >= 3:
                tx, ty = tx[sel], ty[sel]
                o = np.argsort(tx)
                tx, ty = tx[o], ty[o]
                # the digits must lie on one (possibly sloped: the curl is
                # steepest here) bottom line; a stray capital/descender won't
                kf = np.polyfit(tx, ty, 1)
                agree = np.abs(ty - np.polyval(kf, tx)) < 0.25 * xh
                if agree.sum() >= 3 and abs(kf[0]) < 0.5:
                    ax = tx[agree]
                    kf = np.polyfit(ax, ty[agree], 1)
                    # two points (ends of the number) so the fit also sees
                    # the tilt across the number itself
                    pre = [(float(ax.min()), float(np.polyval(kf, ax.min()))),
                           (float(ax.max()), float(np.polyval(kf, ax.max())))]
        # drop glyphs that sit off the baseline of their own neighbours:
        # superscripts such as the raised degree sign in "1°", footnote marks,
        # stray specks. Each glyph is compared with a straight line through its
        # 6 nearest x-height neighbours on the same line (so local curl slope
        # is allowed; at a line start the neighbours are all to the right);
        # a real curl moves neighbours together and survives.
        order = np.argsort(cxs)
        cxs, bys = cxs[order], bys[order]
        good = np.ones(len(cxs), bool)
        K = 6
        for j in range(len(cxs)):
            d = np.abs(cxs - cxs[j])
            d[j] = np.inf
            nbr = np.argsort(d)[:K]
            kf = np.polyfit(cxs[nbr], bys[nbr], 1)
            if abs(bys[j] - np.polyval(kf, cxs[j])) > OUTLIER * xh:
                good[j] = False
        cxs, bys = cxs[good], bys[good]
        if len(cxs) < 8:
            continue
        edges = np.arange(lx, lx + lw + step, step)
        pts = []
        for a, b in zip(edges[:-1], edges[1:]):
            s = (cxs >= a) & (cxs < b)
            if s.any():
                pts.append(((cxs[s].mean()), float(np.median(bys[s]))))
        if len(pts) < 6:
            continue
        p = np.array(pts)
        # running median of 3 removes single-bucket noise but keeps a real
        # lift at the line end (edge values are replicated, not averaged away)
        yv = p[:, 1]
        pad = np.concatenate([[yv[0]], yv, [yv[-1]]])
        yv = np.median(np.stack([pad[:-2], pad[1:-1], pad[2:]]), axis=0)
        # drop points that disagree wildly with their neighbours (mis-assigned chars)
        ok = np.abs(p[:, 1] - yv) < 0.6 * xh
        if ok.sum() < 6:
            continue
        xs_out, ys_out = p[ok, 0], yv[ok]
        if pre is not None:
            xs_out = np.concatenate([[q[0] for q in pre], xs_out])
            ys_out = np.concatenate([[q[1] for q in pre], ys_out])
        traced.append((xs_out, ys_out))
    return traced, xh


EDGE_DENSE = 0.0   # 0 = even knots. >0 packs knots at the page edges; tested, it breaks line starts on curled pages


def _bspline(v: np.ndarray, v0: float, v1: float, n_int: int, edge_dense: float = 0.0) -> np.ndarray:
    k = 3
    u = np.linspace(0.0, 1.0, n_int + 1)
    # page curl is strongest at the page edges, so optionally put narrower
    # intervals there (blend of even and cosine spacing)
    u = (1 - edge_dense) * u + edge_dense * (1 - np.cos(np.pi * u)) / 2
    inner = (v0 + (v1 - v0) * u)[1:-1]
    knots = np.concatenate([[v0] * (k + 1), inner, [v1] * (k + 1)])
    v = np.clip(v, v0, v1 - 1e-9)  # clamp: never extrapolate into the margins
    return BSpline.design_matrix(v, knots, k).toarray()


def _t_basis(ts, t0, t1, nt):
    if T_DEG > 0:
        tn = np.clip(2 * (ts - t0) / max(t1 - t0, 1) - 1, -1.0, 1.0)
        return np.polynomial.legendre.legvander(tn, T_DEG)
    return _bspline(ts, t0, t1, nt)


def _basis(xs, ts, x0, x1, t0, t1, nt):
    bx = _bspline(xs, x0, x1, X_INTERVALS, EDGE_DENSE)
    bt = _t_basis(ts, t0, t1, nt)
    return (bx[:, :, None] * bt[:, None, :]).reshape(len(xs), -1)


def dewarp(img: np.ndarray, work_side: int = 1600) -> tuple[np.ndarray, DewarpInfo]:
    H, W = img.shape[:2]
    s = min(2.5, work_side / max(H, W))
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    h, w = gray.shape

    traced, xh = _trace_baselines(gray)
    if not traced or len(traced) < 4:
        return img, DewarpInfo(False, len(traced or []), reason="not enough text lines")

    # Each line must become a horizontal row. Which row? Measured at the SAME
    # reference x for every line (centre of the text span); otherwise a short
    # line (median taken over its left part) and a long line (median at the
    # centre) disagree about "level" where lines are strongly tilted, and the
    # fit has to split the difference, leaving a residual tilt. Short lines that
    # don't reach the reference get their row from the field itself: solve
    # jointly for the field D and one row offset c_i per line, with the gauge
    # D(x_ref, t) = 0, iterating because the basis depends on the rows.
    bends = []
    for xs, ys in traced:
        bends.append(float(np.abs(ys - np.median(ys)).max()))
    X = np.concatenate([xs for xs, _ in traced])
    Y = np.concatenate([ys for _, ys in traced])
    line_id = np.concatenate([np.full(len(xs), k) for k, (xs, _) in enumerate(traced)])
    n_lines = len(traced)
    c = np.array([float(np.median(ys)) for _, ys in traced])  # initial rows
    x0, x1 = X.min(), X.max()
    x_ref = 0.5 * (x0 + x1)

    nt = int(np.clip(round(n_lines / T_LINES_PER_INTERVAL), T_MIN, T_MAX))
    nbx = X_INTERVALS + 3
    nbt = T_DEG + 1 if T_DEG > 0 else nt + 3
    Dx = np.diff(np.eye(nbx), 2, axis=0)
    P = np.kron(Dx.T @ Dx, np.eye(nbt))
    if T_DEG == 0:
        Dt = np.diff(np.eye(nbt), 2, axis=0)
        P = P + np.kron(np.eye(nbx), Dt.T @ Dt)
    S_ = np.zeros((n_lines, len(X)))
    S_[line_id, np.arange(len(X))] = 1.0  # sample -> its line's offset
    for _ in range(4):
        t0, t1 = c.min() - xh, c.max() + xh
        A = _basis(X, c[line_id], x0, x1, t0, t1, nt)
        tg = np.linspace(t0, t1, max(4 * nbt, 24))
        G = _basis(np.full_like(tg, x_ref), tg, x0, x1, t0, t1, nt)  # gauge rows
        # unknowns z = [coef, c]
        M = np.hstack([A, S_.T])
        MtM = M.T @ M
        lam = SMOOTH * np.trace(A.T @ A) / A.shape[1]
        gw = 10.0 * np.trace(A.T @ A) / len(tg)
        MtM[:A.shape[1], :A.shape[1]] += lam * P + gw * (G.T @ G) + 1e-6 * lam * np.eye(A.shape[1])
        z = np.linalg.solve(MtM, M.T @ Y)
        coef, c_new = z[:A.shape[1]], z[A.shape[1]:]
        done = np.abs(c_new - c).max() < 0.05
        c = c_new
        if done:
            break
    t0, t1 = c.min() - xh, c.max() + xh
    A = _basis(X, c[line_id], x0, x1, t0, t1, nt)
    T = c[line_id]
    b = Y - T
    resid = b - A @ coef

    before = float(np.percentile(bends, 90))
    before_rms = float(np.sqrt(np.mean(np.concatenate(
        [ys - np.median(ys) for _, ys in traced]) ** 2)))
    after = float(np.sqrt(np.mean(resid ** 2)))
    info = DewarpInfo(True, len(traced), before / s, after / s,
                      debug_lines=[(xs / s, ys / s) for xs, ys in traced])
    if before < 0.2 * xh:
        info.applied, info.reason = False, "page already straight"
        return img, info
    if after > 0.7 * before_rms:
        info.applied, info.reason = False, "fit not reliable"
        return img, info

    # evaluate on a coarse grid (clamped to the fitted region so nothing
    # extrapolates into the margins), then interpolate to full resolution
    G = 8
    gx = np.arange(0, W + G, G, dtype=np.float64)
    gy = np.arange(0, H + G, G, dtype=np.float64)
    GX, GY = np.meshgrid(gx * s, gy * s)
    disp = (_basis(GX.ravel(), GY.ravel(), x0, x1, t0, t1, nt) @ coef).reshape(GX.shape) / s
    if EXTRAP_X > 0:
        # Left/right of the traced span (article numbers, list markers: digits
        # are never sampled) continue the field along its slope at the edge
        # instead of holding it flat, for at most EXTRAP_X letter heights.
        # On strongly curled pages the curl keeps steepening towards the
        # page edge, and a flat hold leaves the numbers off their line.
        h_ = 0.5 * xh
        gyv = GY.ravel()
        for xe, sign in ((x0, -1.0), (x1, 1.0)):
            outside = (GX - xe) * sign > 0
            if not outside.any():
                continue
            xin = xe - sign * h_
            de = _basis(np.full_like(gyv, xe), gyv, x0, x1, t0, t1, nt) @ coef
            di = _basis(np.full_like(gyv, xin), gyv, x0, x1, t0, t1, nt) @ coef
            slope = ((de - di) / (sign * h_)).reshape(GX.shape)  # d(disp)/dx at the edge (work px)
            dist = np.clip((GX - xe) * sign, 0, EXTRAP_X * xh)
            disp = disp + np.where(outside, sign * slope * dist / s, 0.0)
    field_full = RectBivariateSpline(gy, gx, disp, kx=3, ky=3)(
        np.arange(H, dtype=np.float64), np.arange(W, dtype=np.float64)).astype(np.float32)

    map_x, map_y = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    out = cv2.remap(img, map_x, map_y + field_full, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    info.reason = "ok"
    return out, info
