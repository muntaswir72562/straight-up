#!/usr/bin/env python3
"""
Full Book Fix PDF processing pipeline (server-side).

Combines straightening, dewarping, cleaning, and OCR in a single pass.
For each page:
  1. Render at target DPI via pymupdf
  2. (if straighten) Detect skew via text line analysis, rotate to fix
  3. (if dewarp) Dewarp curved text lines
  4. (if clean) Clean background/bleed-through
  5. Add to output PDF
  6. (if ocr) Run Tesseract OCR in parallel after processing

Usage:
  python fullfix_pdf.py <input> <output> <progress_file> <book_name> \
    <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1] [skip_clean:1,3,5] [ocr:0|1] \
    [skip_straighten:1,3,5] [skip_dewarp:1,3,5]

Progress is written to <progress_file> as JSON after each page:
  {"phase": "fixing", "current": 5, "total": 50}
"""

import sys
import os
import gc
import json
import multiprocessing
import shutil
import tempfile
import traceback
import numpy as np
import cv2

# Add scripts directory to path so we can import sibling modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import fitz  # pymupdf
except ImportError:
    print("Error: pymupdf required. Install: pip install pymupdf", file=sys.stderr)
    sys.exit(1)

# ── Constants ────────────────────────────────────────────────────────
RENDER_DPI = 300
JPEG_QUALITY = 92
BATCH_SIZE = 20  # pages per batch before flushing to disk


def is_color_page(rgb: np.ndarray) -> bool:
    """True for pages that really contain colour (covers, illustrations,
    photos), False for text pages, including photos/scans of text pages with
    a colour cast (bluish lamp, yellowed paper). The old test (mean
    saturation > 20) called tinted text pages "colour" and skipped them.

    1. Paper colour = median of the brightest 30 % of pixels. If it is only a
       tint (its own saturation < 100, about 40 %), divide it out (white balance), so a
       bluish/yellowish page becomes neutral. A cover whose "paper" is itself
       strongly coloured is colour.
    2. After that, colour = mean saturation > 20, or > 3 % of the pixels
       clearly saturated (> 60): an illustration or photo. A small stamp or
       a highlighted word stays below that.
    """
    rgb = rgb[:, :, :3]
    small = cv2.resize(rgb, (400, int(400 * rgb.shape[0] / rgb.shape[1])), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)
    v = hsv[:, :, 2]
    bright = v >= np.percentile(v, 70)
    paper = np.median(small[bright].reshape(-1, 3), axis=0).astype(np.float32)
    paper_sat = cv2.cvtColor(paper.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2HSV)[0, 0, 1]
    if paper_sat >= 100:
        return True
    wb = small.astype(np.float32) * (paper.mean() / np.maximum(paper, 1))
    s = cv2.cvtColor(np.clip(wb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2HSV)[:, :, 1]
    if not (s.mean() > 20 or (s > 60).mean() > 0.03):
        return False
    # 3. Saturation is a ratio, so dark text letters on a tinted photo come out
    #    "saturated" even though they are barely coloured (a strongly blue-lit
    #    page: 5 % of pixels over 60). Real colour is also clearly coloured in
    #    absolute terms: confirm with chroma (max - min channel) after white
    #    balance. Covers measured 18-39 mean / 15-49 % over 40; text pages,
    #    tinted ones included, at most 12 mean / 3.5 %.
    wbc = np.clip(wb, 0, 255)
    ch = wbc.max(axis=2) - wbc.min(axis=2)
    return bool(ch.mean() > 15 or (ch > 40).mean() > 0.08)


def _num_workers():
    """Auto-detect worker count: min(cpu_count, 4), floor of 2."""
    n = os.cpu_count() or 2
    return max(2, min(n, 4))


# ── Progress ─────────────────────────────────────────────────────────

def write_progress(path, phase, current, total):
    with open(path, 'w') as f:
        json.dump({'phase': phase, 'current': current, 'total': total}, f)


# ── Incremental merge ────────────────────────────────────────────────

def _merge_batches(batch_files, output_path, metadata):
    """Merge batch PDFs into output one at a time to cap memory usage."""
    if len(batch_files) == 1:
        # Single batch — just rename and set metadata
        doc = fitz.open(batch_files[0])
        doc.set_metadata(metadata)
        doc.save(output_path, deflate=True, garbage=3)
        doc.close()
        os.remove(batch_files[0])
        return

    # Start with first batch as the accumulator on disk
    os.rename(batch_files[0], output_path)

    for bf in batch_files[1:]:
        acc = fitz.open(output_path)
        batch = fitz.open(bf)
        acc.insert_pdf(batch)
        batch.close()
        os.remove(bf)
        acc.save(output_path, incremental=True, encryption=0)
        acc.close()
        gc.collect()

    # Set metadata on final file
    final = fitz.open(output_path)
    final.set_metadata(metadata)
    final.save(output_path, incremental=True, encryption=0)
    final.close()


# ── Cancel helper ────────────────────────────────────────────────────

def _is_cancelled(cancel_path):
    """Check if the cancel sentinel file exists."""
    return os.path.isfile(cancel_path)


# ── Fix worker (module-level for multiprocessing pickling) ───────────

def _fix_worker(args):
    """
    Worker function for parallel page fixing.

    Opens the input PDF, renders one page, runs v2/straighten/dewarp/clean,
    optionally saves pre-clean gray image for OCR reuse.

    Returns (page_idx, jpeg_bytes_or_None, (rect_width, rect_height)).
    """
    (input_path, page_idx, total, do_straighten, do_clean, do_dewarp,
     do_v2, skip_clean_list, cancel_path, gray_dir,
     skip_straighten_list, skip_dewarp_list) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (page_idx, None, (0, 0))

    try:
        import fitz as _fitz
        doc = _fitz.open(input_path)
        page = doc[page_idx]
        rect_w = page.rect.width
        rect_h = page.rect.height

        pix = page.get_pixmap(dpi=RENDER_DPI)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.h, pix.w, pix.n).copy()
        n_channels = pix.n
        del pix
        doc.close()

        # Auto color-page detection disabled — user controls which pages
        # to skip via the skip_clean_list (UI: "Leave as-is" pages).
        # is_color = False
        # if (do_clean or do_dewarp or do_v2) and n_channels >= 3:
        #     is_color = is_color_page(img[:, :, :3])

        # Pages in the skip list are left completely unmodified (replaces
        # the old is_color_page auto-detection).
        if skip_clean_list and pnum in skip_clean_list:
            del img
            print(f"[fullfix] Page {pnum}/{total}: skipped (user excluded)",
                  file=sys.stderr)
            return (page_idx, None, (rect_w, rect_h))

        if n_channels == 4:
            gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
        elif n_channels == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            gray = img.copy()
        del img

        modified = False
        result = gray

        # --- V2 Pipeline (replaces straighten + dewarp when enabled) ---
        skip_v2 = skip_straighten_list and pnum in skip_straighten_list
        if do_v2 and not skip_v2:
            from scanner.scan_page import process_page_v2
            result = process_page_v2(result, pnum, total)
            modified = True
        elif do_v2 and skip_v2:
            print(f"[fullfix] Page {pnum}/{total}: skipped v2 (user excluded)",
                  file=sys.stderr)

        if not do_v2 or skip_v2:
            # --- Step 1: Straighten (legacy) ---
            skip_str = skip_straighten_list and pnum in skip_straighten_list
            if do_straighten and not skip_str:
                from straighten_pdf import detect_skew_from_text, straighten_page
                from straighten_pdf import DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE
                h, w = result.shape
                scale = DETECT_WIDTH / w
                dh = int(h * scale)
                small = cv2.resize(result, (DETECT_WIDTH, dh),
                                   interpolation=cv2.INTER_AREA)
                angle, confidence = detect_skew_from_text(small)
                del small

                if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                    result = straighten_page(result, angle)
                    modified = True
                    print(f"[fullfix] Page {pnum}/{total}: straightened {angle:.2f}\u00b0 "
                          f"conf={confidence:.1f}", file=sys.stderr)
                else:
                    print(f"[fullfix] Page {pnum}/{total}: skew={angle:.2f}\u00b0 "
                          f"conf={confidence:.1f} \u2014 no straighten needed",
                          file=sys.stderr)
            elif do_straighten and skip_str:
                print(f"[fullfix] Page {pnum}/{total}: skipped straighten (user excluded)",
                      file=sys.stderr)

            # --- Step 2: Dewarp (legacy) ---
            skip_dw = skip_dewarp_list and pnum in skip_dewarp_list
            if do_dewarp and not skip_dw:
                from clean_pdf import dewarp_page
                dewarped, was_dewarped = dewarp_page(result)
                del result
                result = dewarped
                if was_dewarped:
                    modified = True
                print(f"[fullfix] Page {pnum}/{total}: dewarped={was_dewarped}",
                      file=sys.stderr)
            elif do_dewarp and skip_dw:
                print(f"[fullfix] Page {pnum}/{total}: skipped dewarp (user excluded)",
                      file=sys.stderr)

        # Save pre-clean gray for OCR reuse (before clean modifies it)
        if gray_dir is not None:
            gray_path = os.path.join(gray_dir, f'gray_{pnum:04d}.npy')
            np.save(gray_path, result)

        # --- Step 3: Clean ---
        if do_clean:
            from clean_pdf import clean_page
            cleaned = clean_page(result)
            del result
            result = cleaned
            modified = True
            print(f"[fullfix] Page {pnum}/{total}: cleaned", file=sys.stderr)

        if modified:
            _, jpeg_buf = cv2.imencode('.jpg', result,
                                       [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            del result
            return (page_idx, jpeg_buf.tobytes(), (rect_w, rect_h))
        else:
            del result
            return (page_idx, None, (rect_w, rect_h))

    except Exception as exc:
        print(f"[fullfix] Page {pnum} fix failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (page_idx, None, (0, 0))


# ── OCR worker (module-level for multiprocessing pickling) ───────────

def _ocr_worker(args):
    """
    Worker function for parallel OCR.

    Opens the input PDF, renders one page, optionally runs v2/straighten,
    then runs OCR. Writes per-page JSON to disk for crash safety.

    When gray_dir is provided and a saved .npy file exists for this page,
    the worker skips PDF rendering and preprocessing entirely.

    Returns (page_num, ocr_result_dict) or (page_num, None) on failure.
    """
    (input_path, page_idx, total, do_v2, do_straighten, cancel_path,
     ocr_out_dir, gray_dir) = args
    pnum = page_idx + 1

    if _is_cancelled(cancel_path):
        return (pnum, None)

    try:
        # Try to load pre-processed gray image from fix phase
        gray_path = os.path.join(gray_dir, f'gray_{pnum:04d}.npy') if gray_dir else None
        gray = None

        if gray_path and os.path.isfile(gray_path):
            gray = np.load(gray_path)
            # Don't delete here — main process cleans up gray_dir after OCR
            print(f"[fullfix-ocr] Page {pnum}: reusing saved gray",
                  file=sys.stderr)
        else:
            # Fall back to rendering from PDF + preprocessing
            import fitz as _fitz
            doc = _fitz.open(input_path)
            page = doc[page_idx]
            pix = page.get_pixmap(dpi=RENDER_DPI)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.h, pix.w, pix.n).copy()
            n_ch = pix.n
            del pix

            # Auto color-page detection disabled — skip list handles this
            # is_color = False
            # if n_ch >= 3:
            #     is_color = is_color_page(img[:, :, :3])

            if n_ch == 4:
                gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
            elif n_ch == 3:
                gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            else:
                gray = img.copy()
            del img
            doc.close()

            # Apply v2 or legacy straighten for better OCR accuracy
            if do_v2:
                from scanner.scan_page import process_page_v2
                gray = process_page_v2(gray, pnum, total)
            elif do_straighten:
                from straighten_pdf import detect_skew_from_text, straighten_page
                from straighten_pdf import DETECT_WIDTH, MIN_SKEW_ANGLE, MIN_SKEW_CONFIDENCE
                h, w = gray.shape
                scale = DETECT_WIDTH / w
                dh = int(h * scale)
                small = cv2.resize(gray, (DETECT_WIDTH, dh),
                                   interpolation=cv2.INTER_AREA)
                angle, confidence = detect_skew_from_text(small)
                del small
                if confidence >= MIN_SKEW_CONFIDENCE and abs(angle) >= MIN_SKEW_ANGLE:
                    gray = straighten_page(gray, angle)

        # Check cancel before the expensive Tesseract call
        if _is_cancelled(cancel_path):
            del gray
            return (pnum, None)

        from ocr import ocr_page
        result = ocr_page(gray, page_num=pnum, render_dpi=RENDER_DPI)
        del gray

        # Write per-page JSON immediately (crash-safe partial results)
        page_json = os.path.join(ocr_out_dir, f'page_{pnum:04d}.json')
        with open(page_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

        gc.collect()
        return (pnum, result)

    except Exception as exc:
        print(f"[fullfix-ocr] Page {pnum} OCR failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return (pnum, None)


def run_ocr_phase(input_path, progress_file, total, do_v2, do_straighten,
                  cancel_path, tmp_dir, gray_dir=None):
    """
    Run OCR on all pages using a pool of spawn-context workers.

    When gray_dir is provided, workers reuse pre-processed gray images from
    the fix phase, skipping PDF rendering and preprocessing entirely.
    Results are saved as per-page JSON files and a combined ocr_results.json.
    """
    ocr_out_dir = os.path.join(tmp_dir, 'ocr')
    os.makedirs(ocr_out_dir, exist_ok=True)

    n_workers = _num_workers()
    write_progress(progress_file, 'ocr', 0, total)
    print(f"[fullfix-ocr] Starting OCR on {total} pages ({n_workers} workers)",
          file=sys.stderr)

    ctx = multiprocessing.get_context('spawn')
    pool = ctx.Pool(n_workers)

    tasks = [
        (input_path, idx, total, do_v2, do_straighten, cancel_path,
         ocr_out_dir, gray_dir)
        for idx in range(total)
    ]

    completed = 0
    succeeded = 0

    try:
        for pnum, result in pool.imap_unordered(_ocr_worker, tasks):
            if _is_cancelled(cancel_path):
                print("[fullfix-ocr] Cancelled, terminating pool",
                      file=sys.stderr)
                pool.terminate()
                pool.join()
                sys.exit(0)

            completed += 1
            write_progress(progress_file, 'ocr', completed, total)

            if result is not None:
                succeeded += 1
                conf = result.get('mean_conf', 0)
                words = sum(
                    len(l.get('words', []))
                    for b in result.get('blocks', [])
                    for l in b.get('lines', [])
                )
                print(f"[fullfix-ocr] Page {pnum}/{total}: "
                      f"conf={conf:.1f} words={words}",
                      file=sys.stderr)
            else:
                print(f"[fullfix-ocr] Page {pnum}/{total}: FAILED (skipped)",
                      file=sys.stderr)
    except Exception as exc:
        print(f"[fullfix-ocr] Pool error: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        pool.terminate()
        pool.join()
        raise
    else:
        pool.close()
        pool.join()

    # Assemble combined JSON from per-page files in page order
    combined = []
    for pnum in range(1, total + 1):
        page_path = os.path.join(ocr_out_dir, f'page_{pnum:04d}.json')
        if os.path.isfile(page_path):
            with open(page_path, 'r', encoding='utf-8') as f:
                combined.append(json.load(f))
        else:
            combined.append({
                'page': pnum, 'error': True, 'blocks': [], 'text': '',
            })

    combined_path = os.path.join(tmp_dir, 'ocr_results.json')
    with open(combined_path, 'w', encoding='utf-8') as f:
        json.dump(combined, f, ensure_ascii=False)

    print(f"[fullfix-ocr] Done. {succeeded}/{total} pages succeeded.",
          file=sys.stderr)


# ── Searchable PDF + sidecar (scripts/pdf_out.py) ─────────────────────

from pdf_out import _strip_old_text_layer, _build_searchable_pdf, _write_text_sidecar  # noqa: E402,F401


# ── Same page size for the whole book ───────────────────────────────

# Photographed books come out with every page a slightly different size
# (each photo is cropped on its own) and some pages much smaller (taken from
# further away). Every page is brought to one book size: scaled evenly until
# it fills the book page, and the overflow trimmed from the edges. No white
# space is added and letters keep their shape.
# The trim never cuts into what is printed: the page's content (text, rules,
# stamps, pictures, even faint print; not plain borders, and not marks
# touching the photo's edge or lying in a thin strip along it) must stay
# inside the trimmed page; the cut may sit off-centre to stay in the margin.
# When there is not enough margin, nothing is cut: a page within 2 % of the
# book's shape is stretched to it (invisible); any other page is scaled to
# fit inside the book size and stays a little narrower or shorter.
# A picture page (mostly dark: a cover photo) whose picture runs to the edge
# is trimmed centred anyway: a picture can lose a sliver of its edge, text
# can't. Text pages are never darker than this (their paper is light).
# A landscape page in a portrait book gets the book size turned.
BOOK_SIZE_MAX_TRIM = 0.15     # most a page may lose, across one dimension
BOOK_SIZE_MAX_STRETCH = 0.02  # shape this close to the book's: stretched when it can't be trimmed
BOOK_SIZE_TOLERANCE = 0.5     # pt: pages this close to the book size stay as they are
CONTENT_WIDTH_PX = 270        # pages are looked at this wide to find their content
CONTENT_CONTRAST = 48         # 3x3 grey range that counts as printed content (pictures)
CONTENT_INK = 200             # darker than this, against the paper (255), counts as print
CONTENT_MIN_AREA = 8          # px: smaller marks are specks (photo noise); a letter is >= 8
CONTENT_EDGE = 0.015          # marks entirely in this strip along an edge are ignored
CONTENT_PAD = 0.01            # keep this share of the page clear around the content
PICTURE_MAX_MEDIAN = 128      # page median grey below this = picture page (covers 45-93, text pages >= 169)


def _book_size(sizes):
    """The book's page size: the median short and long side of its pages,
    upright or across as most pages are."""
    if not sizes:
        return None
    short = sorted(min(w, h) for w, h in sizes)
    long_ = sorted(max(w, h) for w, h in sizes)
    m = len(sizes) // 2
    s = short[m] if len(sizes) % 2 else (short[m - 1] + short[m]) / 2.0
    l = long_[m] if len(sizes) % 2 else (long_[m - 1] + long_[m]) / 2.0
    across = sum(1 for w, h in sizes if w > h) > len(sizes) / 2.0
    return (l, s) if across else (s, l)


def _content_box(gray):
    """Box (x0, y0, x1, y1) in 0..1 page fractions around the printed
    content of a small grey image, or None for a page with nothing on it.

    Content is anything clearly darker than the paper around it (after
    evening out the paper shading, so faint print counts too) or with real
    contrast (pictures). Each mark is judged on its own: marks touching the
    image's edge (the photo's edge, the book's edge, the table, shadows) and
    marks lying entirely in a thin strip along an edge are ignored. A line of
    print running off the edge still has its other letters, so the box
    reaches the edge and nothing there is trimmed."""
    h, w = gray.shape[:2]
    k = np.ones((3, 3), np.uint8)
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((9, 9), np.uint8)), 15)
    norm = cv2.divide(gray, bg, scale=255)
    rng = cv2.dilate(gray, k).astype(np.int16) - cv2.erode(gray, k).astype(np.int16)
    mask = ((norm < CONTENT_INK) | (rng > CONTENT_CONTRAST)).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    band = max(2, int(round(CONTENT_EDGE * w)))
    xs0, ys0, xs1, ys1 = [], [], [], []
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < CONTENT_MIN_AREA:
            continue                    # a speck
        if x <= 0 or y <= 0 or x + bw >= w or y + bh >= h:
            continue                    # touches the edge of the photo
        if (x + bw <= band or x >= w - band
                or y + bh <= band or y >= h - band):
            continue                    # lies in the strip along an edge
        xs0.append(x); ys0.append(y); xs1.append(x + bw); ys1.append(y + bh)
    if not xs0:
        return None
    return (min(xs0) / w, min(ys0) / h, max(xs1) / w, max(ys1) / h)


def _place(length, window, lo, hi):
    """Start of a window of the given length on [0, length] that holds
    [lo, hi], as near the centre as possible; None if it can't hold it."""
    a, b = max(0.0, hi - window), min(length - window, lo)
    if a > b + 1e-6:
        return None
    return min(max((length - window) / 2.0, a), b)


def _fit_to_book(pw, ph, book_w, book_h, content=None, picture=False,
                 max_trim=BOOK_SIZE_MAX_TRIM):
    """How a pw x ph page fills the book size.

    content: the printed content as 0..1 page fractions (None: nothing).
    picture: a picture page (a cover photo), trimmed centred when its
    picture runs to the edge.
    Returns (target_w, target_h, (x0, y0, x1, y1)): the page size to use and
    the part of the page shown on it (same shape as the target), or None
    when the page is left as it is."""
    if pw <= 0 or ph <= 0:
        return None
    if (pw > ph) != (book_w > book_h):
        book_w, book_h = book_h, book_w        # landscape page: book turned
    if (abs(pw - book_w) <= BOOK_SIZE_TOLERANCE
            and abs(ph - book_h) <= BOOK_SIZE_TOLERANCE):
        return None
    pad = CONTENT_PAD
    if pw / ph > book_w / book_h:              # wider: trim left and right
        cw = ph * book_w / book_h
        start = None
        if 1.0 - cw / pw <= max_trim:
            lo, hi = ((content[0] - pad) * pw, (content[2] + pad) * pw) if content else (pw / 2, pw / 2)
            start = _place(pw, cw, lo, hi)
            if start is None and picture:
                start = (pw - cw) / 2.0         # picture page: trim centred
        if start is not None:
            return book_w, book_h, (start, 0.0, start + cw, ph)
        if 1.0 - cw / pw <= BOOK_SIZE_MAX_STRETCH:
            return book_w, book_h, (0.0, 0.0, pw, ph)   # tiny stretch
        s = book_w / pw                        # not enough margin: fit inside
    else:                                      # taller: trim top and bottom
        ch = pw * book_h / book_w
        start = None
        if 1.0 - ch / ph <= max_trim:
            lo, hi = ((content[1] - pad) * ph, (content[3] + pad) * ph) if content else (ph / 2, ph / 2)
            start = _place(ph, ch, lo, hi)
            if start is None and picture:
                start = (ph - ch) / 2.0         # picture page: trim centred
        if start is not None:
            return book_w, book_h, (0.0, start, pw, start + ch)
        if 1.0 - ch / ph <= BOOK_SIZE_MAX_STRETCH:
            return book_w, book_h, (0.0, 0.0, pw, ph)   # tiny stretch
        s = book_h / ph
    tw, th = pw * s, ph * s
    if abs(tw - pw) <= BOOK_SIZE_TOLERANCE and abs(th - ph) <= BOOK_SIZE_TOLERANCE:
        return None
    return tw, th, (0.0, 0.0, pw, ph)


def _page_content(page):
    """(content, picture) of a PDF page: its printed content as 0..1
    fractions (see _content_box), and whether it is a picture page (mostly
    dark, like a cover photo)."""
    zoom = CONTENT_WIDTH_PX / max(1.0, page.rect.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
    return _content_box(gray), float(np.median(gray)) < PICTURE_MAX_MEDIAN


def _scale_page_in_place(doc, page, target_w, target_h, clip):
    """Resize a plain page by giving it the new size and putting one
    scaling step in front of its content. Its images and (OCR) text stay on
    the page itself, so later steps see an ordinary page. A turned page
    (/Rotate) gets the turn put into its content first. Returns False when
    the page is not plain (offset page box, links or notes)."""
    if page.rotation:
        try:
            page.remove_rotation()
        except Exception:
            return False
    mb = page.mediabox
    if (page.rotation or abs(mb.x0) > 0.01 or abs(mb.y0) > 0.01
            or abs(page.cropbox.width - mb.width) > 0.01
            or abs(page.cropbox.height - mb.height) > 0.01
            or page.first_annot is not None or page.get_links()):
        return False
    x0, y0, x1, y1 = clip
    sx = target_w / (x1 - x0)
    sy = target_h / (y1 - y0)
    tx = -sx * x0
    ty = -sy * (mb.height - y1)        # PDF space counts y from the bottom
    old = page.get_contents()
    pre = doc.get_new_xref()
    doc.update_object(pre, '<<>>')
    doc.update_stream(pre, (f'q {sx:.6f} 0 0 {sy:.6f} {tx:.4f} {ty:.4f} cm\n').encode())
    post = doc.get_new_xref()
    doc.update_object(post, '<<>>')
    doc.update_stream(post, b'\nQ\n')
    refs = ' '.join(f'{x} 0 R' for x in [pre] + list(old) + [post])
    doc.xref_set_key(page.xref, 'Contents', f'[{refs}]')
    page.set_mediabox(fitz.Rect(0, 0, target_w, target_h))
    return True


def resize_to_book(pdf_path):
    """Bring every page of pdf_path to the book's page size (in place).
    Returns the number of pages resized."""
    doc = fitz.open(pdf_path)
    sizes = [(p.rect.width, p.rect.height) for p in doc]
    book = _book_size(sizes)
    if book is None:
        doc.close()
        return 0
    plans = []
    for i, (w, h) in enumerate(sizes):
        if _fit_to_book(w, h, *book) is None:      # already the book size
            plans.append(None)
            continue
        content, picture = _page_content(doc[i])
        plans.append(_fit_to_book(w, h, *book, content=content, picture=picture))
    if not any(plans):
        doc.close()
        print(f"[fullfix] Resize: all pages already {book[0]:.0f} x {book[1]:.0f} pt",
              file=sys.stderr)
        return 0

    nested = []
    for i, plan in enumerate(plans):
        if plan and not _scale_page_in_place(doc, doc[i], *plan):
            nested.append(i)

    if nested:
        # pages that are not plain: shown through a new page of the book size
        src = fitz.open(pdf_path)
        for i in nested:
            tw, th, clip = plans[i]
            page = doc.new_page(i, width=tw, height=th)
            page.show_pdf_page(page.rect, src, i, clip=fitz.Rect(*clip),
                               keep_proportion=False)
            doc.delete_page(i + 1)
        src.close()

    whole = [i + 1 for i, p in enumerate(plans)
             if p and p[2] == (0.0, 0.0, sizes[i][0], sizes[i][1])
             and {round(p[0], 1), round(p[1], 1)} != {round(book[0], 1), round(book[1], 1)}]
    tmp_out = pdf_path + '.tmp'
    doc.save(tmp_out, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp_out, pdf_path)
    n = sum(1 for p in plans if p)
    print(f"[fullfix] Resize: {n} page(s) brought to {book[0]:.0f} x {book[1]:.0f} pt"
          + (f"; not trimmed (content reaches the edge), fitted inside: {whole}" if whole else ''),
          file=sys.stderr)
    return n


# ── Main pipeline ────────────────────────────────────────────────────

def process_pdf(input_path, output_path, progress_file, book_name='fixed',
                do_straighten=True, do_clean=True, do_dewarp=True, do_v2=False,
                skip_clean_pages=None, gray_dir=None,
                skip_straighten_pages=None, skip_dewarp_pages=None):
    print(f"[fullfix] Opening {input_path}", file=sys.stderr)
    print(f"[fullfix] straighten={do_straighten}, clean={do_clean}, dewarp={do_dewarp}, v2={do_v2}"
          f", skip_clean={skip_clean_pages or 'none'}"
          f", skip_straighten={skip_straighten_pages or 'none'}"
          f", skip_dewarp={skip_dewarp_pages or 'none'}",
          file=sys.stderr)
    doc = fitz.open(input_path)
    total = len(doc)
    n_workers = _num_workers()
    print(f"[fullfix] Starting fix on {total} pages ({n_workers} workers)",
          file=sys.stderr)

    write_progress(progress_file, 'preparing', 0, total)

    tmp_dir = os.path.dirname(output_path)
    cancel_path = os.path.join(tmp_dir, '_cancel')
    batch_files = []
    batch_doc = fitz.open()
    pages_in_batch = 0

    # Convert sets to sorted lists for pickling across spawn-context workers
    skip_clean_list = sorted(skip_clean_pages) if skip_clean_pages else []
    skip_straighten_list = sorted(skip_straighten_pages) if skip_straighten_pages else []
    skip_dewarp_list = sorted(skip_dewarp_pages) if skip_dewarp_pages else []

    ctx = multiprocessing.get_context('spawn')
    pool = ctx.Pool(n_workers)

    tasks = [
        (input_path, idx, total, do_straighten, do_clean, do_dewarp, do_v2,
         skip_clean_list, cancel_path, gray_dir,
         skip_straighten_list, skip_dewarp_list)
        for idx in range(total)
    ]

    # main_doc kept open for copying unmodified pages
    main_doc = fitz.open(input_path)

    try:
        for page_idx, jpeg_bytes, rect_wh in pool.imap(_fix_worker, tasks):
            if _is_cancelled(cancel_path):
                print("[fullfix] Cancelled by user", file=sys.stderr)
                pool.terminate()
                pool.join()
                batch_doc.close()
                main_doc.close()
                doc.close()
                sys.exit(0)

            pnum = page_idx + 1
            write_progress(progress_file, 'fixing', pnum, total)

            if jpeg_bytes is not None:
                w, h = rect_wh
                new_page = batch_doc.new_page(width=w, height=h)
                new_page.insert_image(fitz.Rect(0, 0, w, h), stream=jpeg_bytes)
                del jpeg_bytes
            else:
                # Unmodified page or worker error — copy original
                batch_doc.insert_pdf(main_doc, from_page=page_idx, to_page=page_idx)

            pages_in_batch += 1
            gc.collect()

            # Flush batch to disk to free memory
            if pages_in_batch >= BATCH_SIZE and pnum < total:
                batch_path = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
                batch_doc.save(batch_path, deflate=True)
                batch_doc.close()
                batch_files.append(batch_path)
                batch_doc = fitz.open()
                pages_in_batch = 0
                gc.collect()
                print(f"[fullfix] Flushed batch {len(batch_files)} to disk "
                      f"({pnum}/{total})", file=sys.stderr)
    except Exception:
        pool.terminate()
        pool.join()
        batch_doc.close()
        main_doc.close()
        doc.close()
        raise
    else:
        pool.close()
        pool.join()
        main_doc.close()
        doc.close()

    # Save the last (possibly only) batch
    last_batch = os.path.join(tmp_dir, f'_batch_{len(batch_files)}.pdf')
    batch_doc.save(last_batch, deflate=True)
    batch_doc.close()
    batch_files.append(last_batch)
    gc.collect()

    # Signal saving phase so the UI doesn't stay stuck at 100%
    write_progress(progress_file, 'saving', total, total)

    # Merge batches incrementally — only 2 PDFs in memory at a time
    print(f"[fullfix] Merging {len(batch_files)} batch(es)", file=sys.stderr)
    metadata = {'title': book_name, 'producer': 'Straight Up \u2013 Full Fix'}
    _merge_batches(batch_files, output_path, metadata)

    print("[fullfix] Processing done!", file=sys.stderr)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 7:
        print("Usage: python fullfix_pdf.py <input> <output> <progress_file> "
              "<book_name> <straighten:0|1> <clean:0|1> [dewarp:0|1] [v2:0|1] "
              "[skip_clean:1,3,5] [ocr:0|1]",
              file=sys.stderr)
        sys.exit(1)

    inp = sys.argv[1]
    out = sys.argv[2]
    prog = sys.argv[3]
    name = sys.argv[4]
    straighten = sys.argv[5] == '1'
    clean = sys.argv[6] == '1'
    dewarp = sys.argv[7] == '1' if len(sys.argv) > 7 else False
    v2 = sys.argv[8] == '1' if len(sys.argv) > 8 else False
    skip_clean_raw = sys.argv[9] if len(sys.argv) > 9 else ''
    skip_clean = set()
    if skip_clean_raw:
        for tok in skip_clean_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_clean.add(int(tok))
    ocr = sys.argv[10] == '1' if len(sys.argv) > 10 else False

    skip_straighten_raw = sys.argv[11] if len(sys.argv) > 11 else ''
    skip_straighten = set()
    if skip_straighten_raw:
        for tok in skip_straighten_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_straighten.add(int(tok))

    skip_dewarp_raw = sys.argv[12] if len(sys.argv) > 12 else ''
    skip_dewarp = set()
    if skip_dewarp_raw:
        for tok in skip_dewarp_raw.split(','):
            tok = tok.strip()
            if tok.isdigit():
                skip_dewarp.add(int(tok))

    do_audit = sys.argv[13] == '1' if len(sys.argv) > 13 else True
    book_size = sys.argv[14] == '1' if len(sys.argv) > 14 else True

    has_processing = straighten or clean or dewarp or v2

    if not has_processing and not ocr:
        print("[fullfix] Nothing to do \u2014 all options disabled", file=sys.stderr)
        sys.exit(1)

    tmp_dir = os.path.dirname(os.path.abspath(out))
    cancel_path = os.path.join(tmp_dir, '_cancel')

    # Create gray_dir for sharing pre-processed images between fix and OCR
    gray_dir = None
    if has_processing and ocr:
        gray_dir = os.path.join(tmp_dir, 'gray')
        os.makedirs(gray_dir, exist_ok=True)

    try:
        if has_processing:
            process_pdf(inp, out, prog, name, straighten, clean, dewarp, v2,
                        skip_clean or None, gray_dir=gray_dir,
                        skip_straighten_pages=skip_straighten or None,
                        skip_dewarp_pages=skip_dewarp or None)
        elif ocr:
            # OCR-only mode: copy input to output unchanged
            shutil.copy2(inp, out)
            print(f"[fullfix] OCR-only mode \u2014 copied input to output",
                  file=sys.stderr)

        if ocr:
            doc = fitz.open(inp)
            total = len(doc)
            doc.close()
            run_ocr_phase(inp, prog, total, v2, straighten, cancel_path,
                          tmp_dir, gray_dir=gray_dir)

            # Clean up gray files after OCR is done
            if gray_dir and os.path.isdir(gray_dir):
                shutil.rmtree(gray_dir, ignore_errors=True)

            # Build searchable PDF + sidecar files
            ocr_json_path = os.path.join(tmp_dir, 'ocr_results.json')
            if os.path.isfile(ocr_json_path):
                write_progress(prog, 'saving', 0, 0)
                _build_searchable_pdf(out, ocr_json_path)
                _write_text_sidecar(ocr_json_path,
                                    os.path.join(tmp_dir, 'ocr_text.txt'))

        # ── Same page size for the whole book ──────────────────────
        if book_size:
            try:
                resize_to_book(out)
            except Exception as e:
                print(f"[fullfix] Resize failed, pages keep their sizes: {e}",
                      file=sys.stderr)

        # ── Page audit ─────────────────────────────────────────────
        if do_audit:
            try:
                write_progress(prog, 'checking', 0, 0)
                from page_audit import audit_book
                ocr_json = os.path.join(tmp_dir, 'ocr_results.json')
                rep = audit_book(out, tmp_dir,
                                 ocr_json if ocr and os.path.isfile(ocr_json) else None,
                                 source_pdf=inp)
                print(f"[audit] {rep['summary']}; {len(rep['issues'])} issue(s)",
                      file=sys.stderr)
            except Exception as e:
                print(f"[audit] failed: {e}", file=sys.stderr)

        write_progress(prog, 'done', 0, 0)
    except SystemExit:
        raise
    except Exception as e:
        print(f"[fullfix] Fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        with open(prog, 'w') as f:
            json.dump({'phase': 'error', 'error': str(e), 'current': 0, 'total': 0}, f)
        sys.exit(1)
