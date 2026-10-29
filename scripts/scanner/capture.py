"""
Scan Book: one overhead-camera photo -> 1 or 2 finished pages.

The IRIScan Desk looks straight down at a dark pad. Per capture:
  1. find_book_region: crop to the paper (bright) on the dark pad
  2. detect_spine:     open book (two pages) or a single page / cover
  3. split_spread:     cut along the (possibly tilted/curved) spine
  4. remove_fingers:   skin-coloured blobs on the page border -> paper colour
  5. dewarp:           scanner v2 (process_page_v2_bgr), skips flat pages
  6. colour / clean:   white balance, or clean_pdf.clean_page
  7. OCR:              ocr.ocr_page on the pre-clean grayscale page

Pages are written to disk as soon as they are finished (see write_page).
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field, asdict

import cv2
import numpy as np

WORK_SIDE = 1000      # analysis size for crop / spine detection
CROP_MARGIN = 0.012   # margin kept around the detected paper, fraction of the long side
SPLIT_OVERLAP = 12    # px kept past the spine on each side, so no letter is cut
PAGE_HEIGHT_IN = 9.5  # typical law book height, only used to estimate the DPI
JPEG_QUALITY = 92
THUMB_W = 320         # page strip thumbnails


@dataclass
class Options:
    color_mode: str = "clean"        # "clean" | "colour"
    dewarp: bool = True
    remove_fingers: bool = True
    split: str = "auto"              # "auto" | "one" | "two"
    # per-page overrides, keyed by the page index within the capture (1, 2)
    rotate: dict = field(default_factory=dict)        # {idx: 0|90|180|270}
    keep_colour: dict = field(default_factory=dict)   # {idx: True|False}

    @classmethod
    def from_dict(cls, d: dict | None) -> "Options":
        d = dict(d or {})
        o = cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
        o.rotate = {int(k): int(v) for k, v in (o.rotate or {}).items()}
        o.keep_colour = {int(k): bool(v) for k, v in (o.keep_colour or {}).items()}
        return o


@dataclass
class Split:
    spread: bool
    confidence: float
    source: str                      # "auto" | "override"
    # spine as x = poly(y) in crop coordinates (numpy polyfit order), or None
    spine: list | None = None
    reason: str = ""


def _log(msg):
    print(f"[scan] {msg}", file=sys.stderr)


# ── 1. Book region ───────────────────────────────────────────────────

def find_book_region(bgr: np.ndarray):
    """Bounding box (x0, y0, x1, y1) of the paper on the dark pad, and a
    confidence. An open book's outline is two pages joined at the spine (not
    a quad), so this takes the bounding box of the bright region rather than
    detect_document's quadrilateral. Returns the full frame with confidence 0
    when nothing convincing is found."""
    H, W = bgr.shape[:2]
    s = min(1.0, WORK_SIDE / max(H, W))
    small = cv2.resize(bgr, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA)
    v = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[:, :, 2]
    v = cv2.GaussianBlur(v, (5, 5), 0)
    t, mask = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # paper must be clearly brighter than the pad
    pad = float(np.median(v[mask == 0])) if (mask == 0).any() else 255.0
    paper = float(np.median(v[mask > 0])) if (mask > 0).any() else 0.0
    full = (0, 0, W, H), 0.0
    if paper - pad < 40:
        return full
    k = max(3, int(0.02 * max(small.shape[:2])) | 1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))  # text, spine shadow
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))   # specks on the pad
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    if n < 2:
        return full
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, area = st[i]
    hh, ww = mask.shape
    frac = area / float(hh * ww)
    if frac < 0.10:
        return full
    # keep other big pieces in the box too (a page whose spine valley is so
    # dark it split the paper in two)
    for j in range(1, n):
        if j != i and st[j, cv2.CC_STAT_AREA] > 0.25 * area:
            xj, yj, wj, hj = st[j, :4]
            x, y, w, h = min(x, xj), min(y, yj), max(x + w, xj + wj) - min(x, xj), max(y + h, yj + hj) - min(y, yj)
    if w >= 0.97 * ww and h >= 0.97 * hh:
        return full  # the paper fills the frame: no pad visible, nothing to crop
    m = CROP_MARGIN * max(W, H)
    x0 = max(0, int(x / s - m)); y0 = max(0, int(y / s - m))
    x1 = min(W, int((x + w) / s + m)); y1 = min(H, int((y + h) / s + m))
    conf = float(min(1.0, (paper - pad) / 120.0) * min(1.0, frac / 0.3))
    return (x0, y0, x1, y1), conf


# ── 2/3. Spread or single page, split ────────────────────────────────

SPINE_BAND = (0.30, 0.70)   # spine searched in the middle 40 % of the crop
SPINE_MIN_CONF = 0.5
SPINE_STRIPS = 24           # rows of strips for the line fit


def _ink_mask(gray: np.ndarray) -> np.ndarray:
    """Printed text as 1, paper/shadow as 0 (shading-robust: divide by the
    local paper level first, so the dark gutter itself is not 'ink')."""
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), 31)
    norm = cv2.divide(gray, np.maximum(bg, 1), scale=255)
    return (norm < 170).astype(np.uint8)


def detect_spine(bgr: np.ndarray) -> Split:
    """Open book (two pages) or a single page / cover?

    A spread has, in the middle 40 % of the crop:
      - a vertical band with no text,
      - a shaded valley in the column brightness profile (the gutter),
      - text blocks on both sides of it,
    and is wider than tall. Anything short of that is a single page: a cover
    has no binding line and must never be split. The spine is then traced
    strip by strip (the valley minimum per horizontal strip) and fitted with
    a line, or a parabola when the spine is clearly curved."""
    H, W = bgr.shape[:2]
    s = min(1.0, WORK_SIDE / max(H, W))
    small = cv2.resize(bgr, (max(1, int(W * s)), max(1, int(H * s))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    aspect = w / float(h)
    if aspect < 0.9:
        return Split(False, 0.95, "auto", reason=f"portrait (aspect {aspect:.2f})")

    ink = _ink_mask(gray)
    ink[: int(0.04 * h)], ink[-int(0.04 * h):] = 0, 0
    # paper brightness per column: a high percentile ignores the text
    paper = np.percentile(gray, 75, axis=0).astype(np.float32)
    paper = np.convolve(paper, np.ones(9) / 9, mode="same")
    ink_col = np.convolve(ink.mean(axis=0), np.ones(5) / 5, mode="same")

    a, b = int(SPINE_BAND[0] * w), int(SPINE_BAND[1] * w)
    x0 = a + int(np.argmin(paper[a:b]))
    level = float(np.median(paper[int(0.1 * w):int(0.9 * w)]))
    depth = (level - paper[x0]) / max(level, 1.0)

    # text-free band around the valley
    gap = max(3, int(0.008 * w))
    band_ink = float(ink_col[max(0, x0 - gap):x0 + gap + 1].mean())
    text_l = float(ink_col[int(0.05 * w):max(int(0.05 * w) + 1, x0 - 3 * gap)].mean())
    text_r = float(ink_col[min(w - 1, x0 + 3 * gap):int(0.95 * w)].mean())
    both_text = min(text_l, text_r) > 0.012
    clear_band = band_ink < 0.25 * min(text_l, text_r) + 0.002

    score_depth = np.clip((depth - 0.03) / 0.10, 0, 1)         # 3 % -> 0, 13 % -> 1
    score_aspect = np.clip((aspect - 0.95) / 0.35, 0, 1)        # 0.95 -> 0, 1.3 -> 1
    conf = float(score_depth * 0.5 + score_aspect * 0.3 + (0.2 if clear_band else 0.0))
    why = (f"aspect={aspect:.2f} valley@{x0 / w:.2f} depth={depth:.3f} "
           f"text L/R={text_l:.3f}/{text_r:.3f} band={band_ink:.3f}")
    if not (both_text and clear_band and depth >= 0.03) or conf < SPINE_MIN_CONF:
        return Split(False, round(1.0 - conf, 3), "auto", reason="no spine: " + why)

    # trace the valley strip by strip, within a window around x0
    win = int(0.06 * w)
    ys, xs = [], []
    sh = h / SPINE_STRIPS
    for k in range(SPINE_STRIPS):
        r0, r1 = int(k * sh), int((k + 1) * sh)
        if r1 - r0 < 3:
            continue
        lo, hi = max(0, x0 - win), min(w, x0 + win)
        prof = np.percentile(gray[r0:r1, lo:hi], 75, axis=0).astype(np.float32)
        prof = np.convolve(prof, np.ones(7) / 7, mode="same")
        # skip strips with no valley (top/bottom margin beyond the paper)
        if float(np.median(prof) - prof.min()) < 0.015 * level:
            continue
        ys.append((r0 + r1) / 2.0)
        xs.append(lo + float(np.argmin(prof[3:-3])) + 3)
    if len(ys) < 6:
        poly = [0.0, float(x0)]
    else:
        ys, xs = np.array(ys), np.array(xs)
        keep = np.ones(len(ys), bool)
        for _ in range(3):  # robust: drop strips far from the fit
            p1 = np.polyfit(ys[keep], xs[keep], 1)
            res = np.abs(np.polyval(p1, ys) - xs)
            keep = res < max(3.0, 2.5 * np.median(res[keep]))
        poly = list(np.polyfit(ys[keep], xs[keep], 1))
        if keep.sum() >= 8:
            p2 = np.polyfit(ys[keep], xs[keep], 2)
            r1 = np.abs(np.polyval(poly, ys[keep]) - xs[keep]).mean()
            r2 = np.abs(np.polyval(p2, ys[keep]) - xs[keep]).mean()
            if r2 < 0.6 * r1 and r1 > 1.5:  # clearly curved
                poly = list(p2)
    # back to full-resolution crop coordinates: x = poly(y)
    n = len(poly) - 1
    # x_s = sum c_k y_s^(n-k), X = x_s / s, y_s = s Y  =>  C_k = c_k s^(n-k) / s
    full = [float(c) * (s ** (n - k)) / s for k, c in enumerate(poly)]
    return Split(True, round(conf, 3), "auto", spine=full, reason=why)


def split_spread(bgr: np.ndarray, spine: list | None):
    """Cut a spread into (left, right) along x = poly(y). Each half keeps
    SPLIT_OVERLAP px past the spine; whatever lies beyond that (the other
    page, where the spine is tilted) is filled with the half's paper colour."""
    H, W = bgr.shape[:2]
    ys = np.arange(H, dtype=np.float64)
    xs = np.polyval(spine, ys) if spine is not None else np.full(H, W / 2.0)
    xs = np.clip(xs, 1, W - 1)
    lo, hi = int(np.floor(xs.min())), int(np.ceil(xs.max()))
    left = bgr[:, :min(W, hi + SPLIT_OVERLAP)].copy()
    right = bgr[:, max(0, lo - SPLIT_OVERLAP):].copy()
    off = max(0, lo - SPLIT_OVERLAP)
    cols_l = np.arange(left.shape[1])[None, :]
    cols_r = np.arange(right.shape[1])[None, :] + off
    beyond_l = cols_l > (xs[:, None] + SPLIT_OVERLAP)
    beyond_r = cols_r < (xs[:, None] - SPLIT_OVERLAP)
    for img, beyond in ((left, beyond_l), (right, beyond_r)):
        if beyond.any():
            img[beyond] = paper_colour(img)
    return left, right


# ── 4. Fingers ───────────────────────────────────────────────────────

FINGER_BAND = 0.22        # fingers lie within this fraction of the page from its border
FINGER_MIN_AREA = 0.0015  # of the page area
INPAINT_MAX_AREA = 0.004  # smaller regions are inpainted, larger ones filled with paper colour


def skin_mask(bgr: np.ndarray) -> np.ndarray:
    """Skin-coloured pixels (uint8 0/255) of an image already white-balanced
    on its paper. YCrCb skin range AND an HSV check (warm hue, some
    saturation, not dark): grey or black print, the grey thumb-index tab and
    white paper all have Cr ~ Cb ~ 128 and low saturation, so never match."""
    ycc = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    y, cr, cb = ycc[:, :, 0], ycc[:, :, 1], ycc[:, :, 2]
    hue, sat, val = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    m = ((cr >= 138) & (cr <= 180) & (cb >= 77) & (cb <= 130) & (y >= 50)
         & ((hue <= 25) | (hue >= 165)) & (sat >= 35) & (val >= 70))
    return m.astype(np.uint8) * 255


def remove_fingers(bgr: np.ndarray, page_label: str):
    """Paint out fingers holding the page down. Returns (image, warnings).

    Only skin-coloured blobs that touch the page border and stay within the
    margin band count as fingers. They are filled with the paper colour
    around them (cv2.inpaint for small ones) together with a small halo for
    the finger's shadow, unless text lies under/next to them: then only the
    finger pixels themselves are filled, and a warning is returned."""
    H, W = bgr.shape[:2]
    wb = white_balance(bgr)
    s = min(1.0, WORK_SIDE / max(H, W))
    small = cv2.resize(wb, (max(1, int(W * s)), max(1, int(H * s))), interpolation=cv2.INTER_AREA)
    h, w = small.shape[:2]
    m = skin_mask(small)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    edge = max(2, int(0.015 * max(h, w)))
    bx, by = FINGER_BAND * w, FINGER_BAND * h
    fingers = np.zeros((h, w), np.uint8)
    found = 0
    for i in range(1, n):
        x, y, ww, hh, area = st[i]
        if area < FINGER_MIN_AREA * h * w:
            continue
        touches = (x <= edge, y <= edge, x + ww >= w - edge, y + hh >= h - edge)
        if not any(touches):
            continue
        # how far it reaches into the page, from the border(s) it touches
        reach = []
        if touches[0]: reach.append((x + ww) / bx)
        if touches[2]: reach.append((w - x) / bx)
        if touches[1]: reach.append((y + hh) / by)
        if touches[3]: reach.append((h - y) / by)
        if min(reach) > 1.0:
            continue
        fingers[lab == i] = 255
        found += 1
    if not fingers.any():
        return bgr, []

    full = cv2.resize(fingers, (W, H), interpolation=cv2.INTER_NEAREST)
    # refine at full resolution: skin pixels within the (dilated) blobs
    kf = max(3, int(0.01 * max(H, W)) | 1)
    near = cv2.dilate(full, np.ones((kf, kf), np.uint8)) > 0
    skin = (skin_mask(wb) > 0) & near
    skin = cv2.dilate(skin.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    halo = cv2.dilate(skin.astype(np.uint8), np.ones((kf, kf), np.uint8)) > 0

    # text under the halo (but not the finger itself)?
    gray = cv2.cvtColor(wb, cv2.COLOR_BGR2GRAY)
    ink = _ink_mask(gray).astype(bool) & halo & ~skin
    ink = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    nk = cv2.connectedComponentsWithStats(ink, 8)[0] - 1
    warnings = []
    if nk >= 3:
        region = skin
        warnings.append(f"finger over text on page {page_label}")
    else:
        region = halo

    out = bgr.copy()
    area = int(region.sum())
    if area < INPAINT_MAX_AREA * H * W:
        out = cv2.inpaint(out, region.astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    else:
        # local paper colour: bright, non-skin pixels in a ring around it
        kr = max(5, int(0.03 * max(H, W)) | 1)
        ring = (cv2.dilate(region.astype(np.uint8), np.ones((kr, kr), np.uint8)) > 0) & ~region
        px = bgr[ring]
        if len(px) > 50:
            v = px.max(axis=1)
            px = px[v >= np.percentile(v, 50)]
            colour = np.median(px, axis=0)
        else:
            colour = paper_colour(bgr)
        out[region] = colour.astype(np.uint8)
        # soften the seam (not next to text)
        seam = (cv2.dilate(region.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & ~(
            cv2.erode(region.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
        if not warnings:
            blur = cv2.GaussianBlur(out, (7, 7), 0)
            out[seam] = blur[seam]
    _log(f"page {page_label}: removed {found} finger(s), {area} px"
         + (" (finger over text: finger pixels only)" if warnings else ""))
    return out, warnings


# ── 6. Colour / clean ────────────────────────────────────────────────

def paper_colour(bgr: np.ndarray) -> np.ndarray:
    """Median BGR of the brightest 30 % of pixels (as is_color_page does)."""
    small = bgr if max(bgr.shape[:2]) <= 600 else cv2.resize(
        bgr, (600, max(1, int(600 * bgr.shape[0] / bgr.shape[1]))), interpolation=cv2.INTER_AREA)
    v = small.max(axis=2)
    bright = v >= np.percentile(v, 70)
    return np.median(small[bright].reshape(-1, 3), axis=0).astype(np.float32)


def white_balance(bgr: np.ndarray, target: float = 245.0) -> np.ndarray:
    """Divide out the paper colour (LED cast, yellowed paper) and bring the
    paper to `target` brightness. A strongly coloured "paper" (a cover) only
    gets the brightness normalised, not its colour removed."""
    paper = np.maximum(paper_colour(bgr), 1.0)
    hsv = cv2.cvtColor(paper.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_BGR2HSV)[0, 0]
    gain = target / paper if hsv[1] < 100 else np.full(3, target / float(paper.max()), np.float32)
    gain = np.clip(gain, 0.5, 3.0)
    lut = np.stack([np.clip(np.arange(256) * g, 0, 255) for g in gain], axis=1).astype(np.uint8)
    out = np.empty_like(bgr)
    for c in range(3):
        out[:, :, c] = lut[bgr[:, :, c], c]
    return out


def estimate_dpi(page_h_px: int) -> int:
    return int(np.clip(round(page_h_px / PAGE_HEIGHT_IN), 150, 600))


# ── Pipeline ─────────────────────────────────────────────────────────

def _rotate(img, deg):
    deg = int(deg) % 360
    if deg == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if deg == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if deg == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def decide_split(crop: np.ndarray, opts: Options) -> Split:
    if opts.split == "one":
        return Split(False, 1.0, "override")
    auto = detect_spine(crop)
    if opts.split == "two":
        return Split(True, 1.0, "override", spine=auto.spine if auto.spread else None,
                     reason=auto.reason)
    return auto


def finish_page(bgr: np.ndarray, idx: int, opts: Options, label: str, progress=None):
    """Steps 4-7 for one page. Returns (final image, ocr gray, info)."""
    from fullfix_pdf import is_color_page

    def step(name):
        if progress:
            progress(f"{name} ({label})")

    warnings = []
    bgr = _rotate(bgr, opts.rotate.get(idx, 0))
    if opts.remove_fingers:
        step("fingers")
        bgr, w = remove_fingers(bgr, label)
        warnings += w
    if opts.dewarp:
        step("dewarp")
        from scanner.scan_page import process_page_v2_bgr
        bgr = process_page_v2_bgr(bgr, idx, 0)
    step("colour")
    wb = white_balance(bgr)
    gray = cv2.cvtColor(wb, cv2.COLOR_BGR2GRAY)
    if opts.color_mode == "colour":
        colour = True
    else:
        colour = opts.keep_colour.get(idx, is_color_page(cv2.cvtColor(wb, cv2.COLOR_BGR2RGB)))
    if colour:
        final = wb
    else:
        from clean_pdf import clean_page
        final = clean_page(gray)
    return final, gray, {"colour": bool(colour), "warnings": warnings}


def process_capture(raw_path: str, pages_dir: str, capture_no: int, opts: Options, progress=None):
    """Process one raw capture into pages_dir. Each page is written the
    moment it's done. Returns the list of page metas."""
    from ocr import ocr_page

    img = cv2.imread(raw_path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read {raw_path}")
    if progress:
        progress("crop")
    (x0, y0, x1, y1), crop_conf = find_book_region(img)
    crop = img[y0:y1, x0:x1]
    _log(f"capture {capture_no}: {img.shape[1]}x{img.shape[0]} -> crop {x1 - x0}x{y1 - y0} conf={crop_conf:.2f}")
    del img
    if progress:
        progress("split")
    split = decide_split(crop, opts)
    parts = [crop]
    if split.spread:
        parts = []
        for half in split_spread(crop, split.spine):
            (hx0, hy0, hx1, hy1), _ = find_book_region(half)
            parts.append(half[hy0:hy1, hx0:hx1])
    _log(f"capture {capture_no}: {'spread' if split.spread else 'single'} "
         f"({split.source}, conf={split.confidence:.2f}) {split.reason}")
    del crop

    remove_pages(pages_dir, capture_no)  # a reprocess may go from 2 pages to 1
    metas = []
    for idx, part in enumerate(parts, start=1):
        pid = page_id(capture_no, idx)
        label = pid if len(parts) > 1 else f"{capture_no:04d}"
        final, gray, info = finish_page(part, idx, opts, label, progress)
        dpi = estimate_dpi(final.shape[0])
        if progress:
            progress(f"ocr ({label})")
        ocr = ocr_page(gray, page_num=idx, render_dpi=dpi)
        del gray
        meta = {
            "id": pid, "capture": capture_no, "index": idx, "of": len(parts),
            "width": int(final.shape[1]), "height": int(final.shape[0]), "dpi": dpi,
            "colour": info["colour"], "warnings": info["warnings"],
            "split": asdict(split),
            "crop": {"box": [x0, y0, x1, y1], "confidence": round(crop_conf, 3)},
            "options": asdict(opts),
            "ocr_words": sum(len(l.get("words", [])) for b in ocr.get("blocks", []) for l in b.get("lines", [])),
        }
        write_page(pages_dir, pid, final, ocr, meta)
        metas.append(meta)
    return metas


# ── Disk ─────────────────────────────────────────────────────────────

def page_id(capture_no: int, idx: int) -> str:
    return f"{capture_no:04d}_{idx}"


def remove_pages(pages_dir: str, capture_no: int):
    pre = f"page_{capture_no:04d}_"
    for f in os.listdir(pages_dir) if os.path.isdir(pages_dir) else []:
        if f.startswith(pre):
            os.remove(os.path.join(pages_dir, f))


def _atomic_write(path: str, data: bytes):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_page(pages_dir: str, pid: str, img: np.ndarray, ocr: dict, meta: dict):
    """page_<id>.jpg, .ocr.json, then .meta.json last: a page counts as done
    only once its meta exists."""
    os.makedirs(pages_dir, exist_ok=True)
    base = os.path.join(pages_dir, f"page_{pid}")
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    _atomic_write(base + ".jpg", buf.tobytes())
    _atomic_write(base + ".ocr.json", json.dumps(ocr, ensure_ascii=False).encode("utf-8"))
    th = cv2.resize(img, (THUMB_W, max(1, int(img.shape[0] * THUMB_W / img.shape[1]))), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", th, [cv2.IMWRITE_JPEG_QUALITY, 80])
    _atomic_write(base + ".thumb.jpg", buf.tobytes())
    _atomic_write(base + ".meta.json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
