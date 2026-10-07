#!/usr/bin/env python3
"""
Page-number audit for scanned books.

Detects missing and duplicated pages by reading printed page numbers
(arabic and roman) from the top/bottom bands of each page, learning the
book's numbering layout, and analysing the sequence.

Entry point:
    audit_book(output_pdf, tmp_dir, ocr_json_path=None) -> dict

CLI:
    python page_audit.py <pdf> [ocr_results.json]
"""

import json
import math
import multiprocessing
import os
import re
import sys
import traceback
from collections import Counter
from statistics import mode as stat_mode

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import fitz
except ImportError:
    print("Error: pymupdf required.", file=sys.stderr)
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────
BAND_FRACTION = 0.12        # top/bottom 12 % of page
THUMB_W, THUMB_H = 64, 96   # thumbnail size for image similarity
THUMB_DPI = 40               # render DPI for thumbnails
OCR_DPI = 150                # render DPI for OCR-less path
MIN_INK_FRACTION = 0.003     # below this a page is blank
CORR_THRESHOLD = 0.85        # image correlation threshold for duplicates
TEXT_OVERLAP_THRESHOLD = 0.50 # 3-gram overlap threshold for text duplicates
MIN_NGRAMS = 15              # minimum 3-grams to compare text
SLIDING_WINDOW = 7           # half-width of sliding mode window
MIN_VOTES = 4                # minimum votes for sliding mode
MIN_CONSISTENT_PAIRS = 5     # minimum for a slot to be accepted
CONTEXT_PAGES = 3            # pages on each side to confirm a finding
MAX_PAGE_VALUE = 3000        # reject page numbers above this

# Roman numeral helpers
_ROMAN_VALUES = {'i': 1, 'v': 5, 'x': 10, 'l': 50, 'c': 100, 'd': 500, 'm': 1000}
_ROMAN_PAIRS = [
    (1000, 'm'), (900, 'cm'), (500, 'd'), (400, 'cd'),
    (100, 'c'), (90, 'xc'), (50, 'l'), (40, 'xl'),
    (10, 'x'), (9, 'ix'), (5, 'v'), (4, 'iv'), (1, 'i'),
]


def int_to_roman(n: int) -> str:
    """Convert an integer to a lower-case roman numeral string."""
    if n <= 0:
        return ''
    parts = []
    for value, numeral in _ROMAN_PAIRS:
        while n >= value:
            parts.append(numeral)
            n -= value
    return ''.join(parts)


def roman_to_int(s: str) -> int | None:
    """Convert a roman numeral string to int, or None if invalid."""
    s = s.lower().strip()
    if not s or not re.match(r'^[ivxlcdm]+$', s):
        return None
    total = 0
    prev = 0
    for ch in reversed(s):
        val = _ROMAN_VALUES.get(ch)
        if val is None:
            return None
        if val < prev:
            total -= val
        else:
            total += val
        prev = val
    # Validate round-trip: converting back must give the same string
    if int_to_roman(total) != s:
        return None
    if total < 1 or total > MAX_PAGE_VALUE:
        return None
    return total


# ── Step A: page-number candidates ───────────────────────────────────

# Patterns to strip from tokens
_STRIP_CHARS = re.compile(r'^[\-\u2013\u2014.,;:()\[\]|/\u2022\s]+|[\-\u2013\u2014.,;:()\[\]|/\u2022\s]+$')
_PAGE_PREFIX = re.compile(r'^(?:page|p\.?)\s*', re.IGNORECASE)
_YEAR_RANGE = re.compile(r'^\d{4}\s*[\-\u2013\u2014]\s*\d{2,4}$')
_YEAR = re.compile(r'^(19|20)\d{2}$')
_BRACKETED_REF = re.compile(r'^\[.*\]$')
_OCR_DIGIT_MAP = str.maketrans({'l': '1', 'I': '1', '|': '1', 'O': '0', 'o': '0', 'S': '5'})


def _fix_ocr_digits(token: str) -> str:
    """Fix common OCR confusions in otherwise-numeric tokens."""
    return token.translate(_OCR_DIGIT_MAP)


def _is_junk_token(raw: str, all_words_in_line: list[str] | None = None) -> bool:
    """Return True if a token is clearly not a page number."""
    if _YEAR_RANGE.match(raw):
        return True
    if _YEAR.match(raw):
        return True
    if _BRACKETED_REF.match(raw):
        return True
    # A fraction or section reference like 696/1
    if '/' in raw and any(c.isdigit() for c in raw):
        return True
    return False


def extract_candidates(words: list[dict], page_width: int, page_height: int) -> list[dict]:
    """
    Extract page-number candidates from words in the top/bottom bands.

    Each word dict must have: text, conf, bbox=[x, y, w, h].
    Returns list of candidate dicts.
    """
    top_cutoff = page_height * BAND_FRACTION
    bottom_cutoff = page_height * (1.0 - BAND_FRACTION)
    candidates = []

    for word in words:
        text = word.get('text', '').strip()
        if not text:
            continue
        bx, by, bw, bh = word['bbox']
        cy = by + bh / 2.0
        cx = bx + bw / 2.0

        # Must be in top or bottom band
        if cy > top_cutoff and cy < bottom_cutoff:
            continue

        band = 'top' if cy <= top_cutoff else 'bottom'

        # Horizontal slot
        if cx < page_width * 0.33:
            h_slot = 'left'
        elif cx > page_width * 0.67:
            h_slot = 'right'
        else:
            h_slot = 'centre'

        raw = text
        if _is_junk_token(raw):
            continue

        # Strip surrounding punctuation
        cleaned = _STRIP_CHARS.sub('', raw)
        if not cleaned:
            continue

        # Handle "Page 12" or "p. 12"
        cleaned = _PAGE_PREFIX.sub('', cleaned)
        if not cleaned:
            continue

        # Skip junk after cleaning
        if _is_junk_token(cleaned):
            continue

        conf = word.get('conf', 0)

        # Try arabic
        fixed = _fix_ocr_digits(cleaned)
        if re.match(r'^\d{1,4}$', fixed):
            val = int(fixed)
            if 1 <= val <= MAX_PAGE_VALUE:
                candidates.append({
                    'value': val,
                    'kind': 'arabic',
                    'band': band,
                    'h_slot': h_slot,
                    'slot': f'{band}-{h_slot}',
                    'conf': conf,
                    'text': raw,
                    'weight': 1.0,
                })

        # Try roman
        roman_val = roman_to_int(cleaned)
        if roman_val is not None:
            weight = 1.0
            # Single-letter tokens are weak
            if len(cleaned) == 1 and cleaned.lower() in ('i', 'v', 'x'):
                weight = 0.3
            candidates.append({
                'value': roman_val,
                'kind': 'roman',
                'band': band,
                'h_slot': h_slot,
                'slot': f'{band}-{h_slot}',
                'conf': conf,
                'text': raw,
                'weight': weight,
            })

    return candidates


# ── Step B: learn numbering layout ───────────────────────────────────

def _score_slot(candidates_per_page: list[list[dict]], slot: str, kind: str,
                parity: str) -> int:
    """
    Score a slot by counting consistent consecutive pairs.
    parity is 'odd' or 'even' (1-based scan page index).
    """
    # Collect (scan_index, value) for pages of this parity in this slot+kind
    points = []
    for scan_idx, cands in enumerate(candidates_per_page):
        scan_page = scan_idx + 1  # 1-based
        if parity == 'odd' and scan_page % 2 == 0:
            continue
        if parity == 'even' and scan_page % 2 == 1:
            continue
        for c in cands:
            if c['slot'] == slot and c['kind'] == kind:
                points.append((scan_idx, c['value']))
                break  # one per page per slot

    # Count consistent pairs (same parity = step 2 in scan, step 2 in value)
    score = 0
    for i in range(len(points) - 1):
        si, vi = points[i]
        sj, vj = points[i + 1]
        scan_step = sj - si
        val_step = vj - vi
        if scan_step == val_step:
            score += 1
    return score


def learn_layout(candidates_per_page: list[list[dict]]) -> dict:
    """
    Learn the best slot for odd and even scan pages, per kind.
    Returns {'odd': (slot, kind), 'even': (slot, kind), 'fallback': bool}.
    """
    all_slots = set()
    all_kinds = set()
    for cands in candidates_per_page:
        for c in cands:
            all_slots.add(c['slot'])
            all_kinds.add(c['kind'])

    if not all_slots or not all_kinds:
        return {'odd': None, 'even': None, 'fallback': True}

    best = {}
    for parity in ('odd', 'even'):
        best_score = 0
        best_combo = None
        for slot in all_slots:
            for kind in all_kinds:
                sc = _score_slot(candidates_per_page, slot, kind, parity)
                if sc > best_score:
                    best_score = sc
                    best_combo = (slot, kind)
        if best_score >= MIN_CONSISTENT_PAIRS:
            best[parity] = best_combo
        else:
            best[parity] = None

    fallback = best['odd'] is None and best['even'] is None
    return {'odd': best.get('odd'), 'even': best.get('even'), 'fallback': fallback}


def pick_page_numbers(candidates_per_page: list[list[dict]], layout: dict) -> list[dict | None]:
    """
    For each scan page, pick the best page number candidate.
    Returns a list of candidate dicts (or None if no number found).
    """
    result = []
    for scan_idx, cands in enumerate(candidates_per_page):
        scan_page = scan_idx + 1
        parity = 'odd' if scan_page % 2 == 1 else 'even'
        winning = layout.get(parity)

        if not cands:
            result.append(None)
            continue

        if winning is not None and not layout.get('fallback'):
            slot, kind = winning
            # Filter to winning slot+kind
            matching = [c for c in cands if c['slot'] == slot and c['kind'] == kind]
            if matching:
                # Pick highest weight, then highest conf
                matching.sort(key=lambda c: (c['weight'], c['conf']), reverse=True)
                result.append(matching[0])
                continue

        # Fallback: pick any candidate, preferring higher weight/conf
        if layout.get('fallback') or True:
            # Try all candidates
            sorted_cands = sorted(cands, key=lambda c: (c['weight'], c['conf']), reverse=True)
            result.append(sorted_cands[0])
        else:
            result.append(None)

    return result


# ── Step C: runs and sequence analysis ───────────────────────────────

def _sliding_mode(offsets: list[int | None], center: int, half_w: int = SLIDING_WINDOW,
                  min_votes: int = MIN_VOTES) -> int | None:
    """Compute the mode of non-None offsets within [center-half_w, center+half_w]."""
    lo = max(0, center - half_w)
    hi = min(len(offsets), center + half_w + 1)
    vals = [v for v in offsets[lo:hi] if v is not None]
    if len(vals) < min_votes:
        return None
    counts = Counter(vals)
    return counts.most_common(1)[0][0]


def build_runs(picked: list[dict | None]) -> list[dict]:
    """
    Split the book into kind-runs (roman, arabic).
    Each run: {'kind', 'from_scan' (1-based), 'to_scan', 'pages': [picked entries]}.
    """
    runs = []
    current_kind = None
    current_start = None
    current_pages = []

    for i, p in enumerate(picked):
        kind = p['kind'] if p else None
        if kind and kind != current_kind:
            if current_kind is not None:
                runs.append({
                    'kind': current_kind,
                    'from_scan': current_start + 1,
                    'to_scan': i,  # last scan index of previous run (1-based)
                    'pages': current_pages,
                })
            current_kind = kind
            current_start = i
            current_pages = [p]
        else:
            current_pages.append(p)

    if current_kind is not None:
        runs.append({
            'kind': current_kind,
            'from_scan': current_start + 1,
            'to_scan': len(picked),
            'pages': current_pages,
        })
    elif not runs:
        # No numbers found at all — single run
        runs.append({
            'kind': 'arabic',
            'from_scan': 1,
            'to_scan': len(picked),
            'pages': list(picked),
        })

    return runs


def analyse_run(run: dict) -> tuple[list[dict], list[int | None]]:
    """
    Analyse a single run. Compute smoothed offsets and infer missing numbers.
    Returns (pages_with_inferred, smoothed_offsets).
    """
    pages = run['pages']
    n = len(pages)
    from_scan = run['from_scan']

    # Compute raw offsets: printed[i] - local_index
    raw_offsets: list[int | None] = []
    for i, p in enumerate(pages):
        if p is not None:
            raw_offsets.append(p['value'] - i)
        else:
            raw_offsets.append(None)

    # Smooth with sliding mode
    smoothed: list[int | None] = []
    for i in range(n):
        smoothed.append(_sliding_mode(raw_offsets, i))

    # Infer missing numbers
    result_pages = []
    for i, p in enumerate(pages):
        if p is not None:
            entry = dict(p)
            entry['source'] = 'read'
            entry['scan'] = from_scan + i
            result_pages.append(entry)
        else:
            off = smoothed[i]
            if off is not None:
                inferred_val = i + off
                entry = {
                    'value': inferred_val,
                    'kind': run['kind'],
                    'source': 'inferred',
                    'scan': from_scan + i,
                    'slot': '',
                    'conf': 0,
                    'weight': 0,
                }
                result_pages.append(entry)
            else:
                entry = {
                    'value': None,
                    'kind': run['kind'],
                    'source': 'none',
                    'scan': from_scan + i,
                    'slot': '',
                    'conf': 0,
                    'weight': 0,
                }
                result_pages.append(entry)

    return result_pages, smoothed


# ── Step D: findings ─────────────────────────────────────────────────

def detect_issues(run_pages: list[dict], smoothed: list[int | None],
                  run_kind: str, run_from: int) -> list[dict]:
    """
    Detect missing and duplicate pages from offset changes.
    Only report if at least CONTEXT_PAGES readable pages confirm on each side.
    """
    issues = []
    n = len(smoothed)

    def _readable_count(start: int, end: int) -> int:
        """Count pages with a non-None smoothed offset in [start, end)."""
        return sum(1 for i in range(max(0, start), min(n, end))
                   if smoothed[i] is not None)

    # Look for offset jumps
    prev_offset = None
    prev_i = -1
    for i in range(n):
        off = smoothed[i]
        if off is None:
            continue
        if prev_offset is not None and off != prev_offset:
            delta = off - prev_offset
            # Check context: enough readable pages on each side
            left_count = _readable_count(prev_i - CONTEXT_PAGES, prev_i + 1)
            right_count = _readable_count(i, i + CONTEXT_PAGES + 1)
            if left_count < CONTEXT_PAGES or right_count < CONTEXT_PAGES:
                prev_offset = off
                prev_i = i
                continue

            if delta > 0:
                # Offset went up → missing pages
                # The missing printed numbers are between the last page before
                # the jump and the first page after
                last_before = run_pages[prev_i]['value']
                first_after = run_pages[i]['value']
                if last_before is not None and first_after is not None:
                    missing_nums = list(range(last_before + 1, first_after))
                    if missing_nums:
                        if run_kind == 'roman':
                            printed = [int_to_roman(v) for v in missing_nums]
                        else:
                            printed = [str(v) for v in missing_nums]
                        scan_after = run_from + prev_i  # 1-based scan page
                        scan_before = run_from + i       # 1-based scan page
                        if len(printed) == 1:
                            msg = f"Page {printed[0]} missing (between scan pages {scan_after} and {scan_before})"
                        else:
                            msg = (f"Pages {printed[0]}\u2013{printed[-1]} missing "
                                   f"(between scan pages {scan_after} and {scan_before})")
                        issues.append({
                            'type': 'missing',
                            'confidence': 'high',
                            'printed': printed,
                            'after_scan': scan_after,
                            'before_scan': scan_before,
                            'message': msg,
                        })

            elif delta < 0:
                # Offset went down → possible duplicate
                issues.append({
                    'type': 'duplicate',
                    'confidence': 'low',  # will be upgraded by content check
                    'after_scan': run_from + prev_i,
                    'before_scan': run_from + i,
                    'printed': [],
                    'message': (f"Possible duplicate near scan pages "
                                f"{run_from + prev_i}\u2013{run_from + i}"),
                })

        prev_offset = off
        prev_i = i

    # Check for same printed number on adjacent scan pages
    for i in range(len(run_pages) - 1):
        a = run_pages[i]
        b = run_pages[i + 1]
        if (a['value'] is not None and b['value'] is not None
                and a['value'] == b['value']
                and a['source'] == 'read' and b['source'] == 'read'):
            val_str = int_to_roman(a['value']) if run_kind == 'roman' else str(a['value'])
            issues.append({
                'type': 'duplicate',
                'confidence': 'low',
                'after_scan': run_from + i,
                'before_scan': run_from + i + 1,
                'printed': [val_str],
                'message': (f"Page {val_str} appears on both scan pages "
                            f"{run_from + i} and {run_from + i + 1}"),
            })

            # A duplicate + missing at adjacent positions cancel each
            # other's offset change, so the sliding-mode detector above
            # won't see the gap.  Check explicitly for a gap after the
            # duplicate pair.
            next_read_val = None
            next_read_j = None
            for j in range(i + 2, len(run_pages)):
                if (run_pages[j]['value'] is not None
                        and run_pages[j]['source'] == 'read'):
                    next_read_val = run_pages[j]['value']
                    next_read_j = j
                    break

            if next_read_val is not None:
                expected_next = a['value'] + 1
                if next_read_val > expected_next:
                    missing_nums = list(range(expected_next, next_read_val))
                    if missing_nums:
                        if run_kind == 'roman':
                            printed = [int_to_roman(v) for v in missing_nums]
                        else:
                            printed = [str(v) for v in missing_nums]
                        scan_after = run_from + i + 1
                        scan_before = run_from + next_read_j
                        if len(printed) == 1:
                            msg = (f"Page {printed[0]} missing (between scan "
                                   f"pages {scan_after} and {scan_before})")
                        else:
                            msg = (f"Pages {printed[0]}\u2013{printed[-1]} "
                                   f"missing (between scan pages "
                                   f"{scan_after} and {scan_before})")
                        issues.append({
                            'type': 'missing',
                            'confidence': 'high',
                            'printed': printed,
                            'after_scan': scan_after,
                            'before_scan': scan_before,
                            'message': msg,
                        })

    # Unnumbered stretches
    streak = 0
    streak_start = 0
    for i in range(len(run_pages)):
        if run_pages[i]['source'] == 'none':
            if streak == 0:
                streak_start = i
            streak += 1
        else:
            if streak > 8:
                issues.append({
                    'type': 'info',
                    'confidence': 'low',
                    'after_scan': run_from + streak_start,
                    'before_scan': run_from + streak_start + streak - 1,
                    'printed': [],
                    'message': (f"Unnumbered stretch: scan pages "
                                f"{run_from + streak_start}\u2013"
                                f"{run_from + streak_start + streak - 1} "
                                f"({streak} pages with no readable number)"),
                })
            streak = 0
    if streak > 8:
        issues.append({
            'type': 'info',
            'confidence': 'low',
            'after_scan': run_from + streak_start,
            'before_scan': run_from + streak_start + streak - 1,
            'printed': [],
            'message': (f"Unnumbered stretch: scan pages "
                        f"{run_from + streak_start}\u2013"
                        f"{run_from + streak_start + streak - 1} "
                        f"({streak} pages with no readable number)"),
        })

    return issues


# ── Step E: content checks (duplicates only) ─────────────────────────

def _text_ngrams(text: str, n: int = 3) -> set[tuple[str, ...]]:
    """Extract word n-grams from text, lower-cased, words of 3+ letters."""
    words = [w.lower() for w in re.findall(r'[a-zA-Z]{3,}', text)]
    if len(words) < n:
        return set()
    return {tuple(words[i:i + n]) for i in range(len(words) - n + 1)}


def _image_correlation(thumb_a: np.ndarray, thumb_b: np.ndarray) -> float:
    """Normalised correlation between two thumbnail images."""
    a = thumb_a.astype(np.float32).ravel()
    b = thumb_b.astype(np.float32).ravel()
    a = a - a.mean()
    b = b - b.mean()
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom < 1e-9:
        return 0.0
    return float(np.dot(a, b) / denom)


def check_duplicates(issues: list[dict], all_pages: list[dict],
                     page_texts: list[str] | None,
                     thumbnails: list[np.ndarray] | None) -> list[dict]:
    """
    Confirm or reject duplicate issues using text and image similarity.
    Only flag as duplicate if numbering evidence supports it.
    """
    refined = []
    for issue in issues:
        if issue['type'] != 'duplicate':
            refined.append(issue)
            continue

        scan_a = issue['after_scan']
        scan_b = issue['before_scan']
        idx_a = scan_a - 1
        idx_b = scan_b - 1

        if idx_a < 0 or idx_b < 0:
            refined.append(issue)
            continue
        if idx_a >= len(all_pages) or idx_b >= len(all_pages):
            refined.append(issue)
            continue

        text_match = False
        image_match = False

        # Text check
        if page_texts is not None and idx_a < len(page_texts) and idx_b < len(page_texts):
            ng_a = _text_ngrams(page_texts[idx_a])
            ng_b = _text_ngrams(page_texts[idx_b])
            if len(ng_a) >= MIN_NGRAMS and len(ng_b) >= MIN_NGRAMS:
                overlap = len(ng_a & ng_b)
                smaller = min(len(ng_a), len(ng_b))
                if overlap / smaller > TEXT_OVERLAP_THRESHOLD:
                    text_match = True

        # Image check
        if thumbnails is not None and idx_a < len(thumbnails) and idx_b < len(thumbnails):
            corr = _image_correlation(thumbnails[idx_a], thumbnails[idx_b])
            if corr > CORR_THRESHOLD:
                image_match = True

        # Only report as duplicate if there's numbering evidence
        pa = all_pages[idx_a]
        pb = all_pages[idx_b]
        same_number = (pa['value'] is not None and pb['value'] is not None
                       and pa['value'] == pb['value'])
        adjacent = abs(scan_a - scan_b) <= 1
        numbering_drop = issue.get('_has_drop', False)

        content_confirms = text_match or image_match

        # Important: don't report pages far apart with different numbers
        if not same_number and not adjacent and not numbering_drop:
            continue  # skip this duplicate issue entirely

        if content_confirms:
            issue['confidence'] = 'high'
        # else keep 'low'

        refined.append(issue)

    return refined


# ── Blank detection ──────────────────────────────────────────────────

def is_blank_page(thumb: np.ndarray) -> bool:
    """Check if a thumbnail represents a blank page (< 0.3% ink)."""
    if thumb is None or thumb.size == 0:
        return False
    # Ink = pixels darker than 200 (on 0-255 scale)
    ink_pixels = np.sum(thumb < 200)
    return (ink_pixels / thumb.size) < MIN_INK_FRACTION


# ── OCR for non-OCR path ────────────────────────────────────────────

def _ocr_bands_worker(args):
    """Worker: render a page at OCR_DPI, OCR top and bottom bands."""
    pdf_path, page_idx, total = args
    try:
        import pytesseract
        doc = fitz.open(pdf_path)
        page = doc[page_idx]
        pix = page.get_pixmap(dpi=OCR_DPI, colorspace=fitz.csGRAY)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w).copy()
        h, w = img.shape
        del pix
        doc.close()

        top_h = int(h * BAND_FRACTION)
        bot_start = int(h * (1 - BAND_FRACTION))
        bands = [
            ('top', img[:top_h, :], 0),
            ('bottom', img[bot_start:, :], bot_start),
        ]

        words = []
        for band_name, band_img, y_offset in bands:
            try:
                data = pytesseract.image_to_data(
                    band_img, output_type=pytesseract.Output.DICT,
                    config='--psm 6'
                )
                for i in range(len(data['text'])):
                    text = data['text'][i].strip()
                    if not text:
                        continue
                    conf = int(data['conf'][i]) if data['conf'][i] != '-1' else 0
                    x = int(data['left'][i])
                    y = int(data['top'][i]) + y_offset
                    bw = int(data['width'][i])
                    bh = int(data['height'][i])
                    words.append({
                        'text': text,
                        'conf': conf,
                        'bbox': [x, y, bw, bh],
                    })
            except Exception:
                pass

        return (page_idx, words, w, h)
    except Exception as exc:
        print(f"[audit] OCR band failed for page {page_idx + 1}: {exc}",
              file=sys.stderr)
        return (page_idx, [], 0, 0)


# ── Thumbnail rendering ─────────────────────────────────────────────

def render_thumbnails(pdf_path: str, total: int) -> list[np.ndarray]:
    """Render all pages as 64x96 grayscale thumbnails."""
    thumbs = []
    doc = fitz.open(pdf_path)
    for i in range(total):
        page = doc[i]
        pix = page.get_pixmap(dpi=THUMB_DPI, colorspace=fitz.csGRAY)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w).copy()
        del pix
        thumb = cv2.resize(img, (THUMB_W, THUMB_H), interpolation=cv2.INTER_AREA)
        thumbs.append(thumb)
    doc.close()
    return thumbs


# ── Main entry point ─────────────────────────────────────────────────

def audit_book(output_pdf: str, tmp_dir: str,
               ocr_json_path: str | None = None) -> dict:
    """
    Run page-number audit on a processed book.

    Args:
        output_pdf: path to the output PDF
        tmp_dir: directory for writing page_audit.json
        ocr_json_path: path to ocr_results.json (None if OCR was off)

    Returns:
        The audit report dict (also written to tmp_dir/page_audit.json).
    """
    doc = fitz.open(output_pdf)
    total = len(doc)
    doc.close()

    if total == 0:
        report = {
            'pages': [],
            'runs': [],
            'issues': [],
            'summary': 'Empty document',
        }
        _write_report(report, tmp_dir)
        return report

    print(f"[audit] Starting audit on {total} pages", file=sys.stderr)

    # ── Render thumbnails ─────────────────────────────────────────
    thumbnails = render_thumbnails(output_pdf, total)

    # ── Extract words from bands ──────────────────────────────────
    candidates_per_page: list[list[dict]] = []
    page_texts: list[str] | None = None
    page_dims: list[tuple[int, int]] = []

    if ocr_json_path and os.path.isfile(ocr_json_path):
        # Use existing OCR results
        with open(ocr_json_path, 'r', encoding='utf-8') as f:
            ocr_data = json.load(f)

        page_texts = []
        for page_data in ocr_data:
            pw = page_data.get('width', 0)
            ph = page_data.get('height', 0)
            page_dims.append((pw, ph))

            # Collect all words from all blocks
            all_words = []
            body_text_parts = []
            for block in page_data.get('blocks', []):
                for line in block.get('lines', []):
                    for word in line.get('words', []):
                        all_words.append(word)
                # Collect body text for duplicate checking
                btype = block.get('type', '')
                if btype in ('paragraph', 'article', 'table', 'contents'):
                    body_text_parts.append(block.get('text', ''))

            page_texts.append(' '.join(body_text_parts))
            cands = extract_candidates(all_words, pw, ph)
            candidates_per_page.append(cands)
    else:
        # OCR the bands ourselves
        print(f"[audit] No OCR data, running band OCR on {total} pages",
              file=sys.stderr)
        try:
            ctx = multiprocessing.get_context('spawn')
            n_workers = max(2, min(os.cpu_count() or 2, 4))
            pool = ctx.Pool(n_workers)
            tasks = [(output_pdf, i, total) for i in range(total)]

            results = {}
            for page_idx, words, w, h in pool.imap_unordered(_ocr_bands_worker, tasks):
                results[page_idx] = (words, w, h)
            pool.close()
            pool.join()

            for i in range(total):
                words, w, h = results.get(i, ([], 0, 0))
                page_dims.append((w, h))
                cands = extract_candidates(words, w, h)
                candidates_per_page.append(cands)
        except Exception as exc:
            print(f"[audit] Band OCR failed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            for i in range(total):
                candidates_per_page.append([])
                page_dims.append((0, 0))

    # ── Step B: learn layout ──────────────────────────────────────
    layout = learn_layout(candidates_per_page)
    picked = pick_page_numbers(candidates_per_page, layout)

    # ── Step C: runs and sequence ─────────────────────────────────
    runs = build_runs(picked)

    all_pages: list[dict] = []
    all_issues: list[dict] = []

    for run in runs:
        run_pages, smoothed = analyse_run(run)
        run_issues = detect_issues(run_pages, smoothed, run['kind'], run['from_scan'])
        all_pages.extend(run_pages)
        all_issues.extend(run_issues)

    # Mark blank pages
    for i, page in enumerate(all_pages):
        if i < len(thumbnails):
            page['blank'] = is_blank_page(thumbnails[i])
        else:
            page['blank'] = False

    # ── Step E: content checks for duplicates ─────────────────────
    all_issues = check_duplicates(all_issues, all_pages, page_texts, thumbnails)

    # ── Build output ──────────────────────────────────────────────
    # Format runs for output
    run_summaries = []
    for run in runs:
        # Find the range of printed numbers in this run
        run_pages_slice = all_pages[run['from_scan'] - 1:run['to_scan']]
        values = [p['value'] for p in run_pages_slice if p.get('value') is not None]
        if values:
            lo, hi = min(values), max(values)
            if run['kind'] == 'roman':
                printed_range = f"{int_to_roman(lo)}\u2013{int_to_roman(hi)}"
            else:
                printed_range = f"{lo}\u2013{hi}"
        else:
            printed_range = '?'
        run_summaries.append({
            'kind': run['kind'],
            'from_scan': run['from_scan'],
            'to_scan': run['to_scan'],
            'printed': printed_range,
        })

    # Format pages for output
    out_pages = []
    for p in all_pages:
        val = p.get('value')
        if val is not None:
            if p['kind'] == 'roman':
                printed_str = int_to_roman(val)
            else:
                printed_str = str(val)
        else:
            printed_str = None
        out_pages.append({
            'scan': p['scan'],
            'printed': printed_str,
            'kind': p['kind'],
            'source': p['source'],
            'slot': p.get('slot', ''),
            'blank': p.get('blank', False),
        })

    # Build summary
    if not all_issues:
        range_parts = [r['printed'] for r in run_summaries if r['printed'] != '?']
        if range_parts:
            summary = f"Page numbers continuous: {', '.join(range_parts)}"
        else:
            summary = "No page numbers detected"
    else:
        n_missing = sum(1 for i in all_issues if i['type'] == 'missing')
        n_dup = sum(1 for i in all_issues if i['type'] == 'duplicate')
        parts = []
        if n_missing:
            parts.append(f"{n_missing} missing")
        if n_dup:
            parts.append(f"{n_dup} duplicate")
        summary = f"Issues found: {', '.join(parts)}"

    report = {
        'pages': out_pages,
        'runs': run_summaries,
        'issues': all_issues,
        'summary': summary,
    }

    _write_report(report, tmp_dir)
    return report


def _write_report(report: dict, tmp_dir: str) -> None:
    """Write page_audit.json to the temp directory."""
    out_path = os.path.join(tmp_dir, 'page_audit.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"[audit] Report written to {out_path}", file=sys.stderr)


# ── CLI ──────────────────────────────────────────────────────────────

def _cli_report(report: dict) -> None:
    """Print a readable CLI report."""
    print(f"\n{'=' * 60}")
    print(f"PAGE AUDIT REPORT")
    print(f"{'=' * 60}")
    print(f"\nSummary: {report['summary']}")

    if report['runs']:
        print(f"\nRuns:")
        for r in report['runs']:
            print(f"  {r['kind']:>6}  scan {r['from_scan']}\u2013{r['to_scan']}  "
                  f"printed {r['printed']}")

    if report['issues']:
        print(f"\nIssues ({len(report['issues'])}):")
        for issue in report['issues']:
            conf = issue.get('confidence', '')
            marker = '\u26a0' if conf == 'high' else '\u2139' if conf == 'low' else ' '
            print(f"  {marker} [{issue['type']}] {issue['message']}")
    else:
        print(f"\nNo issues found.")

    # Page listing (abbreviated)
    pages = report.get('pages', [])
    if pages:
        numbered = [p for p in pages if p['printed']]
        blank_count = sum(1 for p in pages if p.get('blank'))
        inferred_count = sum(1 for p in pages if p['source'] == 'inferred')
        none_count = sum(1 for p in pages if p['source'] == 'none')
        print(f"\nPages: {len(pages)} total, {len(numbered)} numbered, "
              f"{inferred_count} inferred, {none_count} unreadable, "
              f"{blank_count} blank")

    print(f"{'=' * 60}\n")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python page_audit.py <pdf> [ocr_results.json]",
              file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    ocr_path = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(pdf_path):
        print(f"Error: {pdf_path} not found", file=sys.stderr)
        sys.exit(1)

    tmp = os.path.dirname(os.path.abspath(pdf_path))

    try:
        report = audit_book(pdf_path, tmp, ocr_path)
        _cli_report(report)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
