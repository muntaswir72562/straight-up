"""
Main page-level OCR function.

Orchestrates:
  1. Get layout info from the scanner (xh, text lines, table grid)
  2. Adaptive upscale based on letter height
  3. Detect tables → per-cell OCR with --psm 6
  4. Full-page OCR with --psm 4
  5. Build layout-aware blocks
  6. Apply post-corrections
  7. Assemble page result dict
"""
import re
import sys

import cv2
import numpy as np

from .engine import run_tesseract, extract_words
from .blocks import build_blocks
from .correct import correct_words, join_hyphenated


def ocr_page(gray, page_num=0, render_dpi=200, lang='fra+eng'):
    """
    Run OCR on a grayscale page image.

    Args:
        gray: grayscale numpy array (H, W), uint8
        page_num: 1-based page number (for logging)
        render_dpi: DPI the image was rendered at
        lang: Tesseract language string

    Returns:
        Dict with keys: page, width, height, scale, xh, mean_conf,
        low_conf_words, blocks, text, and optional header/footer/page_number.
    """
    H, W = gray.shape[:2]

    # Even out the paper shading first. OCR reads the page before Clean
    # (Full Book Fix saves it for OCR), so a photo that gets darker towards
    # one side reached Tesseract as is, and it gave up on the dark part:
    # on a page curving away from the camera only the left half of every
    # line was read. Dividing by the paper level (the same first step as
    # Clean, without its contrast stretch) leaves the letters as they are.
    gray = _flatten_paper(gray)

    # ── Layout analysis via scanner ─────────────────────────────────
    xh, lines_info, table_grid_boxes = _get_layout(gray)

    if xh <= 0:
        xh = 12.0
        print(f'[ocr] Page {page_num}: no text detected, fallback xh={xh}',
              file=sys.stderr)

    # ── Adaptive upscale ────────────────────────────────────────────
    scale = max(1.0, min(3.0, 25.0 / xh))
    dpi = int(render_dpi * scale)

    if scale > 1.01:
        uw, uh = int(W * scale), int(H * scale)
        upscaled = cv2.resize(gray, (uw, uh), interpolation=cv2.INTER_CUBIC)
        print(f'[ocr] Page {page_num}: xh={xh:.1f}px  scale={scale:.2f}x  '
              f'dpi={dpi}  up={uw}x{uh}', file=sys.stderr)
    else:
        upscaled = gray
        print(f'[ocr] Page {page_num}: xh={xh:.1f}px  no upscale  dpi={dpi}',
              file=sys.stderr)

    # ── Table handling (per-cell OCR) ───────────────────────────────
    table_cells = []
    if table_grid_boxes:
        n_grid = len(table_grid_boxes)
        print(f'[ocr] Page {page_num}: table detected ({n_grid} grid lines)',
              file=sys.stderr)
        table_cells = _ocr_table_cells(upscaled, table_grid_boxes, scale,
                                        lang, dpi)

    # ── Full-page OCR ───────────────────────────────────────────────
    try:
        tsv_rows = run_tesseract(upscaled, lang=lang, psm=4, dpi=dpi)
        words = extract_words(tsv_rows, scale=scale)
    except RuntimeError as exc:
        print(f'[ocr] Page {page_num}: tesseract failed: {exc}',
              file=sys.stderr)
        words = []

    # Tesseract's single-column mode (psm 4) skips parts of pages laid out
    # in columns: contents pages and tables of statutes with dot leaders
    # lose their right-hand paragraph numbers, or whole halves of the page.
    # When it read clearly fewer letters than the page has, read the page in
    # two other modes and ADD the words they find where nothing was read.
    # What psm 4 read is kept as it is.
    words = _fill_missed_text(upscaled, words, xh * scale, scale, lang, dpi,
                              page_num)

    del upscaled

    # ── Post-corrections ────────────────────────────────────────────
    words = correct_words(words)

    # ── Build blocks ────────────────────────────────────────────────
    blocks = build_blocks(words, lines_info, table_cells, H, W)

    # Join hyphenated words across lines
    for block in blocks:
        if block.get('lines'):
            block['lines'] = join_hyphenated(block['lines'])
            block['text'] = '\n'.join(
                ' '.join(w['text'] for w in l['words'])
                for l in block['lines'] if l.get('words')
            )

    # ── Stats ───────────────────────────────────────────────────────
    all_words = [
        w for b in blocks
        for l in b.get('lines', [])
        for w in l.get('words', [])
    ]
    if not all_words:
        all_words = words

    confs = [w['conf'] for w in all_words if w.get('conf', -1) >= 0]
    mean_conf = float(np.mean(confs)) if confs else 0.0
    low_conf_words = sum(1 for c in confs if c < 70)

    # ── Assemble text in reading order ──────────────────────────────
    body_types = ('paragraph', 'article', 'table', 'contents')
    body_blocks = [b for b in blocks if b['type'] in body_types]

    body_text = '\n\n'.join(b['text'] for b in body_blocks if b['text'])

    result = {
        'page': page_num,
        'width': W,
        'height': H,
        'scale': round(scale, 3),
        'xh': round(xh, 1),
        'mean_conf': round(mean_conf, 1),
        'low_conf_words': low_conf_words,
        'blocks': blocks,
        'text': body_text,
    }

    # Header / footer / page number as separate top-level fields
    for b in blocks:
        if b['type'] == 'header':
            result.setdefault('header', '')
            if result['header']:
                result['header'] += '\n'
            result['header'] += b['text']
        elif b['type'] == 'footer':
            result.setdefault('footer', '')
            if result['footer']:
                result['footer'] += '\n'
            result['footer'] += b['text']
        elif b['type'] == 'page_number':
            result['page_number'] = b['text'].strip()

    print(f'[ocr] Page {page_num}: mean_conf={mean_conf:.1f}  '
          f'low_conf={low_conf_words}  words={len(all_words)}  '
          f'blocks={len(blocks)}', file=sys.stderr)

    return result


# ── Layout helpers ──────────────────────────────────────────────────

def _flatten_paper(gray):
    """Divide the page by its paper level (large closing): white paper,
    letters keep their contrast to the paper around them."""
    try:
        bl = cv2.GaussianBlur(gray, (3, 3), 0)
        bg = cv2.morphologyEx(
            bl, cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (51, 51)))
        return cv2.divide(gray, bg, scale=255)
    except Exception:
        return gray


# ── Text psm 4 missed ───────────────────────────────────────────────

FILL_MIN_LETTERS = 150       # pages with fewer letters are left alone
FILL_MAX_COVERAGE = 0.95     # psm 4 normally covers >= 0.97 of the letters
FILL_MIN_CONF = 60           # an added word must be read this clearly
FILL_PSMS = (6, 11)          # uniform block, then sparse text


def _letter_centres(img, xh):
    """Centres of the letter-sized ink blobs of the page (image pixels)."""
    bw = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    _, _, st, cen = cv2.connectedComponentsWithStats(bw, 8)
    hh, ww = st[1:, 3], st[1:, 2]
    keep = (hh > 0.4 * xh) & (hh < 3 * xh) & (ww < 4 * xh)
    return cen[1:][keep]


def _inside(cen, bbox, pad=2):
    x, y, w, h = bbox
    return ((cen[:, 0] >= x - pad) & (cen[:, 0] <= x + w + pad)
            & (cen[:, 1] >= y - pad) & (cen[:, 1] <= y + h + pad))


def _overlap_frac(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    return (ix * iy) / float(max(1, min(aw * ah, bw * bh)))


def _fill_missed_text(upscaled, words, xh_up, scale, lang, dpi, page_num):
    try:
        cen = _letter_centres(upscaled, xh_up) / float(scale)   # page pixels
        if len(cen) < FILL_MIN_LETTERS:
            return words
        covered = np.zeros(len(cen), bool)
        for w in words:
            if w['text'].strip():
                covered |= _inside(cen, w['bbox'])
        before = covered.mean()
        if before >= FILL_MAX_COVERAGE:
            return words
        kept = [w for w in words if w['text'].strip()]
        added = []
        for psm in FILL_PSMS:
            extra = extract_words(
                run_tesseract(upscaled, lang=lang, psm=psm, dpi=dpi), scale=scale)
            for w in extra:
                t = w['text'].strip()
                if (w['conf'] < FILL_MIN_CONF or not t
                        or not any(ch.isalnum() for ch in t)):
                    continue
                ins = _inside(cen, w['bbox'])
                if not (ins & ~covered).any():
                    continue        # nothing new under this word
                if any(_overlap_frac(w['bbox'], k['bbox']) > 0.3
                       for k in kept):
                    continue        # already read there
                w = dict(w)
                # keep the line grouping of this pass apart from psm 4's
                w['block_num'] = w['block_num'] + 1000 * psm
                kept.append(w)
                added.append(w)
                covered |= ins
            if covered.mean() >= FILL_MAX_COVERAGE:
                break
        if added:
            print(f'[ocr] Page {page_num}: psm 4 covered {before:.0%} of the '
                  f'letters; added {len(added)} words from other modes '
                  f'({covered.mean():.0%})', file=sys.stderr)
            return words + added
    except Exception as exc:     # never lose the first reading
        print(f'[ocr] Page {page_num}: fill-in failed: {exc}', file=sys.stderr)
    return words


def _get_layout(gray):
    """
    Get layout info from the scanner.

    Returns:
        (xh, Lines_or_None, table_grid_boxes_in_original_px)
    """
    try:
        from scanner.layout import find_lines
        from scanner.dewarp import table_grid as _table_grid
    except ImportError:
        return 0, None, []

    H, W = gray.shape[:2]
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    lines = find_lines(bgr)

    if lines is None:
        return 0, None, []

    xh = lines.xh  # in original (full-res) pixels

    # Check for table grid at working scale (same scale find_lines uses)
    s = min(2.5, 1600 / max(H, W))
    sh, sw = int(H * s), int(W * s)
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC
    small = cv2.resize(gray, (sw, sh), interpolation=interp)

    # Binarize (same method as scanner.dewarp._binarize)
    bg = cv2.medianBlur(cv2.dilate(small, np.ones((7, 7), np.uint8)), 31)
    norm = cv2.divide(small, bg, scale=255)
    block = max(15, (min(sh, sw) // 40) | 1)
    binv = cv2.adaptiveThreshold(
        norm, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, block, 15,
    )

    xh_work = xh * s
    grid = _table_grid(binv, xh_work)
    if grid:
        grid = [
            (int(gx / s), int(gy / s), int(gw / s), int(gh / s))
            for gx, gy, gw, gh in grid
        ]
    else:
        grid = []

    return xh, lines, grid


def _ocr_table_cells(upscaled, grid_boxes, scale, lang, dpi):
    """
    OCR individual table cells from the grid.

    Separates horizontal / vertical grid lines, builds a cell matrix,
    crops each cell with padding, and runs Tesseract with --psm 6.

    Returns:
        List of (row_idx, col_idx, text, bbox_in_original_px).
    """
    # Separate H and V lines by aspect ratio
    h_lines = []
    v_lines = []
    for x, y, w, h in grid_boxes:
        if w > h * 2:
            h_lines.append(y + h / 2.0)
        elif h > w * 2:
            v_lines.append(x + w / 2.0)

    if len(h_lines) < 2 or len(v_lines) < 2:
        return []

    h_lines = sorted(set(int(round(v)) for v in h_lines))
    v_lines = sorted(set(int(round(v)) for v in v_lines))

    # Deduplicate lines that are very close (within 5 px)
    h_lines = _dedup(h_lines, 5)
    v_lines = _dedup(v_lines, 5)

    if len(h_lines) < 2 or len(v_lines) < 2:
        return []

    cells = []
    uh, uw = upscaled.shape[:2]
    # Crop just INSIDE the grid lines (the old crop reached outside them, so
    # the cell borders were read as "|", "_" and junk), and give Tesseract a
    # white margin to work with instead.
    inset = max(3, int(round(4 * scale)))
    margin = max(8, int(round(10 * scale)))

    for ri in range(len(h_lines) - 1):
        for ci in range(len(v_lines) - 1):
            y0, y1 = h_lines[ri], h_lines[ri + 1]
            x0, x1 = v_lines[ci], v_lines[ci + 1]
            cell_bbox = [x0, y0, x1 - x0, y1 - y0]
            if y1 - y0 < 5 or x1 - x0 < 5:
                cells.append((ri, ci, '', cell_bbox, []))
                continue

            # Crop in upscaled coordinates
            sx0 = max(0, int(x0 * scale) + inset)
            sy0 = max(0, int(y0 * scale) + inset)
            sx1 = min(uw, int(x1 * scale) - inset)
            sy1 = min(uh, int(y1 * scale) - inset)
            if sx1 - sx0 < 5 or sy1 - sy0 < 5:
                cells.append((ri, ci, '', cell_bbox, []))
                continue
            crop = upscaled[sy0:sy1, sx0:sx1]

            if crop.size < 100 or crop.min() > 200:
                # tiny or blank cell
                cells.append((ri, ci, '', cell_bbox, []))
                continue
            crop = cv2.copyMakeBorder(crop, margin, margin, margin, margin,
                                      cv2.BORDER_CONSTANT, value=255)

            words = []
            try:
                tsv = run_tesseract(crop, lang=lang, psm=6, dpi=dpi,
                                     timeout=30)
                cw = extract_words(tsv, scale=1.0)
                for w in cw:
                    t = w['text'].strip()
                    # leftovers of the cell border and specks
                    if not t or re.fullmatch(r"[|_\-\u2014\u2013=~'\u2018\u2019\".,:;]+", t):
                        continue
                    if w['conf'] < 30 and len(t) <= 2:
                        continue
                    bx, by, bw, bh = w['bbox']
                    # crop (upscaled, with margin) -> original page pixels
                    w = dict(w)
                    w['text'] = t
                    w['bbox'] = [int((sx0 - margin + bx) / scale),
                                 int((sy0 - margin + by) / scale),
                                 max(1, int(bw / scale)), max(1, int(bh / scale))]
                    words.append(w)
                text = ' '.join(w['text'] for w in words).strip()
            except Exception:
                text = ''
                words = []

            cells.append((ri, ci, text, cell_bbox, words))

    return cells


def _dedup(sorted_vals, min_gap):
    """Keep only one representative from clusters of values within min_gap."""
    if not sorted_vals:
        return []
    out = [sorted_vals[0]]
    for v in sorted_vals[1:]:
        if v - out[-1] >= min_gap:
            out.append(v)
    return out
