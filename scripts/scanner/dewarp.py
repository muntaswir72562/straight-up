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
TRACE_RULES = True  # also trace horizontal printed lines (table grids, rules) as straight references
TABLE_SECOND_PASS = True  # table pages (>= 3 traced grid lines): run the correction twice
RULE_MIN_W = 0.12  # shortest traced line, as a fraction of the page width (one table column)
EXTEND_LEADERS = True  # follow dot leaders / end numbers past a line's last letter (see _extend_right)
USE_PREFIX = True  # sample article numbers / list markers at line starts (see _trace_baselines)
EXTRAP_X = 6.0     # continue the field past the traced span along its edge slope for up to this many letter heights (0 = hold flat)
TRACE_PIECES = True  # also measure short text pieces (a date column, a column of short entries) that are too short to be traced as lines
JUMP_COLUMNS = True  # attach lone page numbers / dates to the line whose row they continue (see _attach_groups)
VIRTUAL_EXT = 0.1  # weight of virtual samples continuing each line straight to the traced span's ends (see _virtual_ext)
FAR_SLOPE = True   # beyond EXTRAP_X, continue the field with the lines' average slope (page skew) instead of holding flat
EDGE_FOLD = True   # sharp curl in the last/first word of the lines (page folding over at the edge): add knots there (see _edge_knots)
FOLD_SMOOTH = 0.01  # smoothness when edge knots are used: a fold needs a sharp bend the normal penalty flattens
FEW_ROWS = 6       # pages with fewer text rows use the simple shape (at most quadratic down the page, 4 intervals across): 4-5 rows can't pin a cubic, it swings between them
MAX_SHIFT = 6.0   # refuse a correction that moves text by more than this x max(measured bend, letter height)
TRIM_ENDS = True   # drop a stray first/last baseline sample (raised opening quote, bullet) that jumps off the line (see _trim_ends)
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
        return None, None, []
    # typical letter height. Ignore marks much smaller than letters first:
    # dot leaders ("......" in contents pages, tables of cases) can outnumber
    # letters and would drag a plain median down to the size of a dot.
    _h = bh[cand]
    _big = _h >= 0.6 * np.percentile(_h, 75)
    xh = float(np.median(_h[_big])) if _big.sum() >= 20 else float(np.median(_h))
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
    traced, pieces, groups = [], [], []
    for i in range(1, n2):
        lx, ly, lw, lh, la = st2[i]
        if lw < 0.15 * w:
            if TRACE_PIECES:
                pc = _trace_piece(i, st2[i], line_of, centres, bottoms, heights, xh, w)
                if pc is not None:
                    pieces.append(pc)
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
        if TRIM_ENDS:
            p = _trim_ends(p, xh)
            if len(p) < 6:
                continue
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
        if EXTEND_LEADERS:
            xs_out, ys_out = _extend_right(xs_out, ys_out, st, cent, xh, w, h)
        traced.append((xs_out, ys_out))
    if JUMP_COLUMNS and traced:
        long_blob = np.zeros(n2, bool)
        long_blob[1:] = st2[1:, 2] >= 0.15 * w
        groups = _lone_words(chars, idx, cx, cy, centres, bottoms, heights, line_of, long_blob, xh, w)
        if groups:
            traced = _attach_column(traced, groups, xh)
    if TRACE_RULES and table_grid(binv, xh):
        traced += _trace_rules(binv, xh)
    return traced, xh, pieces


def _lone_words(chars, idx, cx, cy, centres, bottoms, heights, line_of, long_blob, xh, w):
    """Short words standing alone, not part of any text line (the page
    numbers of a contents page, dates): (centre x, baseline, x0, x1).
    Words are glyphs joined across gaps < 1 letter height; a 3-digit page
    number is narrower than the 2-letter-height opening used for lines, so
    lines can't be used here."""
    kw = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(round(1.0 * xh))), 1))
    words = cv2.morphologyEx(chars, cv2.MORPH_CLOSE, kw)
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(words, 8)
    word_of = lab3[cy, cx]
    in_line = long_blob[line_of]
    groups = []
    for i in range(1, n3):
        lx, ly, lw, lh, la = st3[i]
        if lw >= 0.15 * w or lw < 0.8 * xh or lh > 2.2 * xh:
            continue
        m = (word_of == i)
        if in_line[m].any():
            continue
        m &= (heights > 0.55 * xh) & (heights < 1.9 * xh)
        if m.sum() < 2:
            continue
        by = bottoms[m]
        med = float(np.median(by))
        ok = np.abs(by - med) < 0.2 * xh
        if ok.sum() < 2 or ok.sum() < 0.6 * m.sum():
            continue
        # the number's own baseline (its tilt in the photo), sampled at its
        # first and last glyph: one point at the centre would let the field
        # bend around it and rotate the digits
        gx, gb = centres[m][ok].astype(np.float64), by[ok]
        if len(gx) >= 3 and np.ptp(gx) > 0.8 * xh:
            k = np.polyfit(gx, gb, 1)
            if abs(k[0]) > 0.2:
                k = np.array([0.0, med])
        else:
            k = np.array([0.0, med])
        a, b = float(gx.min()), float(gx.max())
        groups.append((float(lx + lw / 2.0), med, float(lx), float(lx + lw),
                       (a, float(np.polyval(k, a))), (b, float(np.polyval(k, b)))))
    return groups


def _attach_column(traced, groups, xh):
    """Attach lone short words (page numbers) to the text line whose row
    they continue, across the gap.

    On a contents page the page numbers sit far right of the entries with
    nothing in between, so the curl correction has no measurement there and
    can only extrapolate — the number column then ends up a row off. Each
    number is on the baseline of its entry's row. Per column (numbers right
    of all lines' ends, or left of all starts), the vertical offset between
    a number and the END of its row's baseline changes smoothly down the
    page (page tilt / curl across the gap), so fit
        y_number = y_row_end + d(y),  d linear in y (then quadratic),
    by RANSAC over number<->row candidate pairs, and attach a number to a
    row only if it fits within 0.25 letter heights and no other row does.
    Pages where no consistent column is found are unchanged.
    """
    ends = []
    for k, (xs, ys) in enumerate(traced):
        o = np.argsort(xs)
        ends.append((xs[o][0], ys[o][0], xs[o][-1], ys[o][-1]))
    E = np.array(ends)
    add = [[] for _ in traced]
    for side in (1, -1):
        if side > 0:
            G = [g for g in groups if g[2] > E[:, 2].max() + 2 * xh]
            ry = E[:, 3]
        else:
            G = [g for g in groups if g[3] < E[:, 0].min() - 2 * xh]
            ry = E[:, 1]
        # one column only: the numbers share a right edge (left edge on the
        # left side); other short words (article ranges "203 à 211") don't
        if len(G) < 5:
            continue
        edge = np.array([g[3] if side > 0 else g[2] for g in G])
        e0 = np.median(edge)
        G = [g for g, e in zip(G, edge) if abs(e - e0) < 1.5 * xh]
        if len(G) < 5:
            continue
        rs = np.diff(np.sort(ry))
        rs = rs[rs > 0.8 * xh]
        rowsp = float(np.median(rs)) if len(rs) else 2.5 * xh
        gy = np.array([g[1] for g in G])
        # candidate pairs: each number with rows within +-4 letter heights
        cand = [(i, j) for i in range(len(G)) for j in range(len(ry)) if abs(gy[i] - ry[j]) < 4 * xh]
        if len(cand) < 5:
            continue
        cand = np.array(cand)
        dy = gy[cand[:, 0]] - ry[cand[:, 1]]
        yy = gy[cand[:, 0]]
        best, best_p = -1, None
        rng = np.random.default_rng(0)
        for _ in range(400):
            a, b = rng.choice(len(cand), 2, replace=False)
            if cand[a, 0] == cand[b, 0] or abs(yy[a] - yy[b]) < 3 * xh:
                continue
            p = np.polyfit([yy[a], yy[b]], [dy[a], dy[b]], 1)
            # a number is on ITS row: the offset across the gap must stay
            # well under one row spacing, or the hypothesis is "one row off"
            if np.abs(np.polyval(p, gy)).max() > 0.45 * rowsp:
                continue
            inl = np.abs(dy - np.polyval(p, yy)) < 0.25 * xh
            cnt = len(np.unique(cand[inl, 0]))
            if cnt > best:
                best, best_p = cnt, p
        # most rows that have a number must agree (short entries aren't
        # traced as lines, so there can be fewer rows than numbers)
        if best_p is None or best < max(5, 0.6 * min(len(G), len(ry))):
            continue
        p = best_p
        for deg in (1, 2):
            inl = np.abs(dy - np.polyval(p, yy)) < 0.25 * xh
            if inl.sum() > 3 * (deg + 1):
                q = np.polyfit(yy[inl], dy[inl], deg)
                if np.abs(np.polyval(q, gy)).max() <= 0.45 * rowsp:
                    p = q
        res = np.abs(dy - np.polyval(p, yy))
        for i in range(len(G)):
            m = cand[:, 0] == i
            r = res[m]
            if not len(r):
                continue
            o = np.argsort(r)
            if r[o[0]] < 0.25 * xh and (len(r) == 1 or r[o[1]] > 0.6 * xh):
                add[cand[m][o[0], 1]].extend([G[i][4], G[i][5]])
    out = []
    for (xs, ys), extra in zip(traced, add):
        if extra:
            xs = np.concatenate([xs, [e[0] for e in extra]])
            ys = np.concatenate([ys, [e[1] for e in extra]])
        out.append((xs, ys))
    return out


def _trim_ends(p: np.ndarray, xh: float) -> np.ndarray:
    """Drop a first/last baseline sample that jumps off its line.

    The running median below replicates the edge values, so a single stray
    sample at a line END survives it: e.g. the raised opening quote of
    '"obtains' (two small marks of x-height size, so they pass as letters,
    and next to each other, so the per-glyph neighbour test doesn't catch
    them). One such sample 1 letter height too high bent the whole top-left
    of a page. A real curl changes gradually, so an end sample is compared
    with the straight continuation of its two neighbours; off by more than
    half a letter height -> dropped (repeated, at both ends).
    """
    while len(p) >= 4 and abs(p[0, 1] - (2 * p[1, 1] - p[2, 1])) > 0.5 * xh:
        p = p[1:]
    while len(p) >= 4 and abs(p[-1, 1] - (2 * p[-2, 1] - p[-3, 1])) > 0.5 * xh:
        p = p[:-1]
    return p


def _trace_piece(i, st_i, line_of, centres, bottoms, heights, xh, w):
    """Baseline of a short text piece: one word or entry in a column that is
    too short to count as a text line ("1849-1852" in a date column, "Leach"
    in a column of abbreviations). Such columns can lie wholly outside the
    traced lines, where the field would otherwise only be extrapolated and
    rotates the words. A piece only tells the fit its local TILT (it gets its
    own row offset, like every line), never which row it belongs to.

    Letters, digits and capitals all sit on the baseline; descenders and
    raised marks are dropped by requiring the bottoms to agree on one
    straight line (>= 4 glyphs within 0.25 letter heights).
    """
    lx, ly, lw, lh, la = st_i
    if lw < 3 * xh:
        return None
    thick = la / max(lw, 1)
    if thick > 2.2 * xh or thick < 0.3 * xh:
        return None
    m = (line_of == i) & (heights > 0.55 * xh) & (heights < 1.9 * xh)
    if m.sum() < 4:
        return None
    cx, by = centres[m].astype(np.float64), bottoms[m]
    base = np.median(by)
    for _ in range(2):
        sel = np.abs(by - base) < 0.4 * xh if np.ndim(base) == 0 else np.abs(by - np.polyval(base, cx)) < 0.25 * xh
        if sel.sum() < 4 or np.ptp(cx[sel]) < 2 * xh:
            return None
        base = np.polyfit(cx[sel], by[sel], 1)
    if abs(base[0]) > 0.3:
        return None
    a, b = float(cx[sel].min()), float(cx[sel].max())
    return (np.array([a, b]), np.array([np.polyval(base, a), np.polyval(base, b)]))


def _trace_rules(binv: np.ndarray, xh: float):
    """Horizontal printed lines (table grid lines, header/footer rules) are
    straight on the real page, exactly like text baselines, and they span the
    full width — including table columns with too little text to trace (a
    first column of short labels like "s 19E (4)"). Trace their centre line
    so the curl correction also straightens them and everything around them.
    """
    h, w = binv.shape
    m = cv2.morphologyEx(binv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 15), 1)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    step = max(4, int(2 * xh))
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if bw < RULE_MIN_W * w or area / bw > max(4, 0.6 * xh) or bh > 3 * xh:
            continue
        if x <= 2 or y <= 2 or x + bw >= w - 2 or y + bh >= h - 2:
            continue
        sub = (lab[y:y + bh, x:x + bw] == i)
        rows = np.arange(bh)[:, None]
        xs, ys = [], []
        for cx in range(0, bw - step + 1, step):
            c = sub[:, cx:cx + step]
            cnt = c.sum()
            if cnt >= step:  # mostly continuous here
                xs.append(x + cx + step / 2)
                ys.append(y + float((c * rows).sum()) / cnt)
        if len(xs) >= 6:
            out.append((np.array(xs), np.array(ys)))
    return out


def _extend_right(xs, ys, st, cent, xh, w, h):
    """Follow a line past its last letter along dot leaders and the number
    at the end ("Samy v/s ... 2020 SCJ 306 ...............457/1").

    Dots and digits are not x-height letters, so the baseline trace stops at
    the last word; on a table of cases or contents page that leaves the right
    half of the page with no measurements. Dots and digits sit on the
    baseline too: walk right along the line's current direction and take
    blobs whose bottom lies on the predicted baseline (+-0.35 letter heights),
    one step at most 4 letter heights ahead. On ordinary text lines there is
    nothing to the right, so nothing changes.
    """
    x, y, bw, bh, area = (st[1:, i] for i in range(5))
    ok = (area >= 2) & (bh < 1.9 * xh) & (bw < 3 * xh) & (x > 2) & (y > 2) & (x + bw < w - 2) & (y + bh < h - 2)
    cx = cent[1:, 0][ok]
    by = (y + bh)[ok].astype(np.float64)
    o = np.argsort(xs)
    xs, ys = list(np.asarray(xs)[o]), list(np.asarray(ys)[o])
    step = 2.0 * xh
    while True:
        k = min(6, len(xs))
        kf = np.polyfit(xs[-k:], ys[-k:], 1) if k >= 2 else np.array([0.0, ys[-1]])
        x_end = xs[-1]
        cand = (cx > x_end + 0.2 * xh) & (cx <= x_end + 4 * xh)
        cand &= np.abs(by - np.polyval(kf, cx)) < 0.35 * xh
        if not cand.any():
            break
        # take the blobs of the next step-wide bucket only, then continue
        x0 = cx[cand].min()
        b = cand & (cx < x0 + step)
        xs.append(float(cx[b].mean()))
        ys.append(float(np.median(by[b])))
        if len(xs) > 400:
            break
    return np.array(xs), np.array(ys)


EDGE_DENSE = 0.0   # 0 = even knots. >0 packs knots at the page edges; tested, it breaks line starts on curled pages


_XK = []  # extra inner x knots for the current page (see EDGE_FOLD)


def _far_content(gray, xh, x0, x1):
    """Sides (+1 right, -1 left) with a column of text far outside the traced
    lines (> EXTRAP_X letter heights away): the page numbers of a contents
    page, a column of dates. Only then are virtual samples used, so ordinary
    pages are unchanged."""
    binv = _binarize(gray)
    n, _, st, cent = cv2.connectedComponentsWithStats(binv, 8)
    h, w = gray.shape
    bw, bh, area = st[1:, 2], st[1:, 3], st[1:, 4]
    ok = (bh > 0.5 * xh) & (bh < 2.0 * xh) & (bw < 3 * xh) & (area > 6)
    ok &= (st[1:, 0] > 2) & (st[1:, 1] > 2) & (st[1:, 0] + bw < w - 2) & (st[1:, 1] + bh < h - 2)
    cx, cy = cent[1:, 0][ok], cent[1:, 1][ok]
    gap = EXTRAP_X * xh
    out = []
    for side, m in ((1, cx > x1 + gap), (-1, cx < x0 - gap)):
        if m.sum() < 8:
            continue
        # a real column: glyphs on at least 5 different rows, spread over a
        # third of the page height (not a stray mark or a few specks)
        rows = np.unique(np.round(cy[m] / (1.5 * xh)))
        if len(rows) >= 5 and np.ptp(cy[m]) > 0.33 * h:
            out.append(side)
    return tuple(out)


def _virtual_ext(traced, xh, x0, x1, sides=(1, -1)):
    """Weak virtual samples that continue every text line straight (with the
    slope of its own end) out to the ends of the traced span.

    The field is fitted on the area the lines cover. Where a corner has no
    lines at all — e.g. the top right of a contents page, where the entries
    are short and only the lower lines reach far right — the field there is
    pure extrapolation of the polynomial down the page and can swing the
    wrong way, moving the page numbers a whole row off. With no other
    evidence, a text line continues straight; these samples say exactly that,
    with a small weight, so real samples always win where they exist.
    """
    step = 2.0 * xh
    vx, vy, vl = [], [], []
    for k, (xs, ys) in enumerate(traced):
        if len(xs) < 4:
            continue
        o = np.argsort(xs); xs, ys = xs[o], ys[o]
        for side in sides:
            if side > 0:
                xe, xa, ya = x1, xs[-6:], ys[-6:]
                start = xs[-1]
            else:
                xe, xa, ya = x0, xs[:6], ys[:6]
                start = xs[0]
            if abs(xe - start) < 2 * step:
                continue
            kf = np.polyfit(xa, ya, 1)
            pts = np.arange(start + side * step, xe + side * 1e-6, side * step)
            vx.extend(pts); vy.extend(np.polyval(kf, pts)); vl.extend([k] * len(pts))
    return np.array(vx, float), np.array(vy, float), np.array(vl, int)


def _edge_knots(traced, xh, x0, x1):
    """Extra knots near a page edge where the lines bend sharply.

    Where the paper folds over at the outer edge (or into the spine), the
    whole bend happens within the last word of each line. The even knot
    spacing (1/10 of the text width, ~7 letter heights) is too coarse to
    follow it, so the last word stays lifted. Measure it: for each line
    reaching that edge, how far its end samples leave the straight
    continuation of the samples before them. Only if the typical line bends
    by more than 0.3 letter heights there, add knots 1.5/3/4.5/6 letter
    heights from that edge. Pages without such a fold get no extra knots
    (unchanged result).
    """
    out = []
    for side in (1, -1):
        edge = x1 if side > 0 else x0
        bends = []
        for xs, ys in traced:
            o = np.argsort(xs) if side > 0 else np.argsort(-xs)
            xs_, ys_ = xs[o], ys[o]
            if len(xs_) < 9 or abs(xs_[-1] - edge) > 3 * xh:
                continue  # line doesn't reach this edge
            if np.abs(np.diff(xs_[-4:])).max() > 4 * xh:
                continue  # a gap (page number attached across white space): not a fold
            k = np.polyfit(xs_[-9:-3], ys_[-9:-3], 1)
            bends.append(float(np.max(np.abs(ys_[-3:] - np.polyval(k, xs_[-3:])))))
        if len(bends) >= 5 and np.median(bends) > 0.3 * xh:
            out += [edge - side * m * xh for m in (1.5, 3.0, 4.5, 6.0)]
    return out


def _bspline(v: np.ndarray, v0: float, v1: float, n_int: int, edge_dense: float = 0.0, extra=()) -> np.ndarray:
    k = 3
    u = np.linspace(0.0, 1.0, n_int + 1)
    # page curl is strongest at the page edges, so optionally put narrower
    # intervals there (blend of even and cosine spacing)
    u = (1 - edge_dense) * u + edge_dense * (1 - np.cos(np.pi * u)) / 2
    inner = (v0 + (v1 - v0) * u)[1:-1]
    if len(extra):
        inner = np.sort(np.concatenate([inner, [e for e in extra if v0 < e < v1]]))
    knots = np.concatenate([[v0] * (k + 1), inner, [v1] * (k + 1)])
    v = np.clip(v, v0, v1 - 1e-9)  # clamp: never extrapolate into the margins
    return BSpline.design_matrix(v, knots, k).toarray()


def _t_basis(ts, t0, t1, nt):
    if T_DEG > 0:
        tn = np.clip(2 * (ts - t0) / max(t1 - t0, 1) - 1, -1.0, 1.0)
        return np.polynomial.legendre.legvander(tn, T_DEG)
    return _bspline(ts, t0, t1, nt)


def _basis(xs, ts, x0, x1, t0, t1, nt):
    bx = _bspline(xs, x0, x1, X_INTERVALS, EDGE_DENSE, _XK)
    bt = _t_basis(ts, t0, t1, nt)
    return (bx[:, :, None] * bt[:, None, :]).reshape(len(xs), -1)


def dewarp(img: np.ndarray, work_side: int = 1600, _few: bool = False, _second: bool = False) -> tuple[np.ndarray, DewarpInfo]:
    H, W = img.shape[:2]
    s = min(2.5, work_side / max(H, W))
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    h, w = gray.shape

    traced, xh, pieces = _trace_baselines(gray)
    if not traced or len(traced) < 2:
        return img, DewarpInfo(False, len(traced or []), reason="not enough text lines")
    # count distinct ROWS, not traced pieces: two pieces of the same row
    # (a line broken by a wide gap) pin down nothing more down the page
    rws = np.sort([float(np.median(ys)) for _, ys in traced])
    n_rows = 1 + int((np.diff(rws) > 1.0 * xh).sum())
    if n_rows < FEW_ROWS and not _few:
        # Short pages (a table of cases with 2-3 entries): still correct them,
        # but with a simpler shape that 2-3 lines can actually pin down —
        # a straight or quadratic change down the page and 4 intervals across.
        global T_DEG, X_INTERVALS
        saved = (T_DEG, X_INTERVALS)
        T_DEG, X_INTERVALS = min(max(n_rows - 1, 0), 2), 4
        try:
            return dewarp(img, work_side, _few=True, _second=_second)
        finally:
            T_DEG, X_INTERVALS = saved

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
    before_rms = float(np.sqrt(np.mean(np.concatenate(
        [ys - np.median(ys) for _, ys in traced]) ** 2)))
    n_main = len(traced)
    # pieces add tilt information only (own row each), and only between the
    # first and last traced line: the field is not extended by them to a
    # footer or page number above/below the text
    rows = [float(np.median(ys)) for _, ys in traced]
    lo, hi = min(rows) - 0.5 * xh, max(rows) + 0.5 * xh
    traced = traced + [pc for pc in pieces if lo <= pc[1].mean() <= hi]
    X = np.concatenate([xs for xs, _ in traced])
    Y = np.concatenate([ys for _, ys in traced])
    line_id = np.concatenate([np.full(len(xs), k) for k, (xs, _) in enumerate(traced)])
    n_lines = len(traced)
    c = np.array([float(np.median(ys)) for _, ys in traced])  # initial rows
    x0, x1 = X.min(), X.max()
    _XK[:] = _edge_knots(traced[:n_main], xh, x0, x1) if EDGE_FOLD else []
    x_ref = 0.5 * (x0 + x1)
    Wt = np.ones(len(X))
    sides = _far_content(gray, xh, x0, x1) if VIRTUAL_EXT > 0 else ()
    if sides:
        vx, vy, vl = _virtual_ext(traced[:n_main], xh, x0, x1, sides)
        if len(vx):
            # only fill holes: drop a virtual sample when real samples exist
            # near it (within 2 steps across, 3 letter heights up/down)
            near = np.zeros(len(vx), bool)
            for j in range(0, len(vx), 512):
                dx = np.abs(vx[j:j + 512, None] - X[None, :]) < 4 * xh
                dy = np.abs(vy[j:j + 512, None] - Y[None, :]) < 3 * xh
                near[j:j + 512] = (dx & dy).any(axis=1)
            vx, vy, vl = vx[~near], vy[~near], vl[~near]
        if len(vx):
            X = np.concatenate([X, vx]); Y = np.concatenate([Y, vy])
            line_id = np.concatenate([line_id, vl]); Wt = np.concatenate([Wt, np.full(len(vx), VIRTUAL_EXT)])

    nt = int(np.clip(round(n_lines / T_LINES_PER_INTERVAL), T_MIN, T_MAX))
    nbx = _bspline(np.array([x0]), x0, x1, X_INTERVALS, EDGE_DENSE, _XK).shape[1]
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
        MtM = M.T @ (Wt[:, None] * M)
        AtA = A.T @ (Wt[:, None] * A)
        lam = (FOLD_SMOOTH if _XK else SMOOTH) * np.trace(AtA) / A.shape[1]
        gw = 10.0 * np.trace(AtA) / len(tg)
        MtM[:A.shape[1], :A.shape[1]] += lam * P + gw * (G.T @ G) + 1e-6 * lam * np.eye(A.shape[1])
        z = np.linalg.solve(MtM, M.T @ (Wt * Y))
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
    after = float(np.sqrt(np.mean(resid[(line_id < n_main) & (Wt == 1)] ** 2)))
    info = DewarpInfo(True, n_main, before / s, after / s,
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
            if FAR_SLOPE:
                # Further out (a column of page numbers far right of the
                # entries on a contents page) continue with the line's AVERAGE
                # slope over the traced span instead of holding flat: that is
                # the page's skew / perspective, which keeps going across the
                # gap; holding flat leaves such a column a row off.
                da = _basis(np.full_like(gyv, x0), gyv, x0, x1, t0, t1, nt) @ coef
                db = _basis(np.full_like(gyv, x1), gyv, x0, x1, t0, t1, nt) @ coef
                mslope = ((db - da) / max(x1 - x0, 1.0)).reshape(GX.shape)
                far = np.clip((GX - xe) * sign - EXTRAP_X * xh, 0, None)
                disp = disp + np.where(outside, sign * mslope * far / s, 0.0)
    if MAX_SHIFT > 0:
        # safety net: inside the text area the correction can't move text
        # much further than the measured bend; a field that does is a fit
        # gone wrong (too few rows to pin it down), so leave the page alone
        yy, xx = np.meshgrid(gy, gx, indexing="ij")
        X_all = np.concatenate([xs for xs, _ in traced]) / s
        Y_all = np.concatenate([ys for _, ys in traced]) / s
        m = (xx >= X_all.min()) & (xx <= X_all.max()) & (yy >= Y_all.min() - 2 * xh / s) & (yy <= Y_all.max() + 2 * xh / s)
        lim = MAX_SHIFT * max(before, xh) / s
        if m.any() and np.abs(disp[m]).max() > lim:
            info.applied, info.reason = False, "correction implausible"
            return img, info
    field_full = RectBivariateSpline(gy, gx, disp, kx=3, ky=3)(
        np.arange(H, dtype=np.float64), np.arange(W, dtype=np.float64)).astype(np.float32)

    map_x, map_y = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    out = cv2.remap(img, map_x, map_y + field_full, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    info.reason = "ok"
    # Table pages: steeply curved grid lines aren't recognised as lines on the
    # first pass (the shape test wants a nearly straight run). After one pass
    # they are nearly straight, so a second pass can trace and flatten them.
    if TABLE_SECOND_PASS and not _second and table_grid(_binarize(gray), xh):
        out2, info2 = dewarp(out, work_side, _few=_few, _second=True)
        if info2.applied:
            info.after_px = info2.after_px
            info.reason = "ok (2 passes)"
            return out2, info
    return out, info



def table_grid(binv: np.ndarray, xh: float):
    """Grid lines of a table, or [] if the page has no table.

    A table's grid is one connected shape, so size tests on connected
    components never see its lines. Pull straight horizontal and vertical
    strokes out by shape (morphological opening with a long thin kernel,
    after thickening 7 px across so a slightly leaning line still forms one
    run). A grid line always meets a line of the other direction; lines lying
    along the photo edge (the page edge) are ignored, lines that only touch
    the photo edge at their end (a table cut off by the photo) may confirm a
    crossing line but are not returned. The page only counts as a table if at
    least 2 horizontal AND 3 vertical lines remain — so ordinary pages (header
    rules, page-edge shadows, a frame around the image) are never tables.
    Returns boxes (x, y, w, h) in binv coordinates.
    """
    h, w = binv.shape
    extra, axis_of, edge_of = [], [], []
    for kw, kh, min_len, axis in ((max(15, w // 20), 1, 0.15 * w, 0), (1, max(15, h // 25), 0.08 * h, 1)):
        src = cv2.dilate(binv, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 7) if axis == 0 else (7, 1)))
        m = cv2.morphologyEx(src, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh)))
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 1) if axis == 0 else (1, 5)))
        _, _, sr, _ = cv2.connectedComponentsWithStats(m, 8)
        for rx, ry, rw, rh, ra in sr[1:]:
            length, thick_ = (rw, ra / max(rw, 1)) if axis == 0 else (rh, ra / max(rh, 1))
            touches = rx <= 2 or ry <= 2 or rx + rw >= w - 2 or ry + rh >= h - 2
            # lying along (or within 2.5% of) the photo edge: the page edge or
            # a frame around the whole image, not a table line
            mh, mw = 0.025 * h, 0.025 * w
            along = (ry <= mh or ry + rh >= h - mh) if axis == 0 else (rx <= mw or rx + rw >= w - mw)
            if along:
                continue
            if length >= min_len and thick_ < max(10, 1.2 * xh):
                extra.append((rx, ry, rw, rh)); axis_of.append(axis); edge_of.append(touches)
    if not extra:
        return []
    E = np.array(extra, dtype=np.float64); A = np.array(axis_of); Ed = np.array(edge_of)
    tol = 4
    keep = np.zeros(len(E), bool)
    for i in range(len(E)):
        if Ed[i]:
            continue
        o = E[A != A[i]]
        if len(o) == 0:
            continue
        x0, y0, x1, y1 = E[i, 0] - tol, E[i, 1] - tol, E[i, 0] + E[i, 2] + tol, E[i, 1] + E[i, 3] + tol
        keep[i] = bool(((o[:, 0] < x1) & (o[:, 0] + o[:, 2] > x0) & (o[:, 1] < y1) & (o[:, 1] + o[:, 3] > y0)).any())
    # a table has column separators: >= 3 vertical lines (left border, one
    # inner line, right border) and >= 2 horizontal lines. A single rectangle
    # (a box or a frame around the page) is not a table.
    if (keep & (A == 0)).sum() < 2 or (keep & (A == 1)).sum() < 3:
        return []
    return [tuple(int(v) for v in e) for e in E[keep]]
