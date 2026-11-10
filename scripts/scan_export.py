#!/usr/bin/env python3
"""
Scan Book export: pages/ of a scan session -> searchable PDF (+ .txt, audit).

Usage:
  python scan_export.py <session_dir> <output_pdf> <progress_file> [txt:0|1] [audit:0|1]

Page order comes from session.json ("order": page ids). Images are added in
batches flushed to disk (as fullfix_pdf does), so a 400-page book needs
little memory. The OCR JSON of each page is renumbered to its position and
laid over the images as an invisible text layer (pdf_out).
"""
import gc
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fitz  # noqa: E402

from fullfix_pdf import _merge_batches, write_progress, BATCH_SIZE  # noqa: E402
from pdf_out import _build_searchable_pdf, _write_text_sidecar  # noqa: E402


BOOK_MAX_OVER_MEDIAN = 1.25  # the book page is at most this much bigger than a typical page


def _median(vals):
    vals = sorted(vals)
    return vals[len(vals) // 2]


def _book_dpi(metas):
    """One scale for the whole book. The DPI of a page is estimated from its
    height in pixels, so a capture with a bigger crop got another DPI and its
    letters came out another size. All pages come from the same camera."""
    return float(_median([float(m.get("dpi") or 300) for m in metas]))


def _size_pt(meta, dpi):
    return meta["width"] / dpi * 72.0, meta["height"] / dpi * 72.0


def _book_page_size(metas, dpi):
    """One page size for the whole book, big enough for its pages. The two
    halves of a spread, and captures taken with a different crop, come out in
    different sizes; every page gets this size. Capped at 1.25x the median
    page, so one capture without a crop (mostly pad) doesn't blow it up."""
    sizes = [_size_pt(m, dpi) for m in metas]
    mw, mh = _median([s[0] for s in sizes]), _median([s[1] for s in sizes])
    w = min(max(s[0] for s in sizes), mw * BOOK_MAX_OVER_MEDIAN)
    h = min(max(s[1] for s in sizes), mh * BOOK_MAX_OVER_MEDIAN)
    return w, h


def _page_side(meta):
    """Where the page sits on the book page: against the spine for the halves
    of a spread (the left page on the right, the right page on the left),
    centred otherwise."""
    if meta.get("of") != 2:
        return "centre"
    rot = (meta.get("options") or {}).get("rotate") or {}
    if int(rot.get(str(meta.get("index")), rot.get(meta.get("index"), 0)) or 0) % 360:
        return "centre"
    return "right" if meta.get("index") == 1 else "left"


def _fit(w_pt, h_pt, page_w, page_h, side="centre"):
    """Image rect (x0, y0, x1, y1) of a w_pt x h_pt page on a page_w x page_h
    page: at its own size (only shrunk when bigger than the page), centred
    vertically, horizontally against the spine or centred."""
    k = min(1.0, page_w / w_pt, page_h / h_pt)
    dw, dh = w_pt * k, h_pt * k
    x0 = {"left": 0.0, "right": page_w - dw}.get(side, (page_w - dw) / 2.0)
    y0 = (page_h - dh) / 2.0
    return x0, y0, x0 + dw, y0 + dh


def _place_ocr(ocr, img_w, rect, page_w, page_h):
    """OCR boxes are in image pixels; the text layer maps the OCR width x
    height onto the whole page. Turn them into pixels of the whole page so
    the invisible words stay on the printed ones when the image is inset."""
    x0, y0, x1, _ = rect
    f = (x1 - x0) / float(img_w)          # points per image pixel
    ox, oy = x0 / f, y0 / f
    # no early return when the offset is 0: the image may still be narrower
    # than the page, and the width/height below must then change
    for b in ocr.get("blocks", []):
        for item in [b] + b.get("lines", []) + [w for l in b.get("lines", []) for w in l.get("words", [])]:
            bb = item.get("bbox")
            if bb and len(bb) == 4:
                item["bbox"] = [bb[0] + ox, bb[1] + oy, bb[2], bb[3]]
    ocr["width"] = page_w / f
    ocr["height"] = page_h / f


def export(session_dir, out_pdf, progress, do_txt=True, do_audit=False):
    with open(os.path.join(session_dir, "session.json"), encoding="utf-8") as f:
        session = json.load(f)
    pages_dir = os.path.join(session_dir, "pages")
    order = [p for p in session.get("order", []) if os.path.isfile(os.path.join(pages_dir, f"page_{p}.meta.json"))]
    total = len(order)
    if total == 0:
        raise ValueError("no finished pages to export")
    out_dir = os.path.dirname(os.path.abspath(out_pdf))
    write_progress(progress, "building", 0, total)

    metas = []
    for pid in order:
        with open(os.path.join(pages_dir, f"page_{pid}.meta.json"), encoding="utf-8") as f:
            metas.append(json.load(f))
    dpi = _book_dpi(metas)
    page_w, page_h = _book_page_size(metas, dpi)

    batch_files, batch, n_in_batch = [], fitz.open(), 0
    ocr_all = []
    for i, (pid, meta) in enumerate(zip(order, metas), start=1):
        base = os.path.join(pages_dir, f"page_{pid}")
        w_pt, h_pt = _size_pt(meta, dpi)
        rect = _fit(w_pt, h_pt, page_w, page_h, _page_side(meta))
        page = batch.new_page(width=page_w, height=page_h)
        page.insert_image(fitz.Rect(*rect), filename=base + ".jpg")
        try:
            with open(base + ".ocr.json", encoding="utf-8") as f:
                ocr = json.load(f)
        except (OSError, ValueError):
            ocr = {"error": True, "blocks": [], "text": ""}
        if not ocr.get("error"):
            _place_ocr(ocr, ocr.get("width") or meta["width"], rect, page_w, page_h)
        ocr["page"] = i
        ocr_all.append(ocr)
        n_in_batch += 1
        write_progress(progress, "building", i, total)
        if n_in_batch >= BATCH_SIZE and i < total:
            bp = os.path.join(out_dir, f"_batch_{len(batch_files)}.pdf")
            batch.save(bp, deflate=True)
            batch.close()
            batch_files.append(bp)
            batch, n_in_batch = fitz.open(), 0
            gc.collect()
    bp = os.path.join(out_dir, f"_batch_{len(batch_files)}.pdf")
    batch.save(bp, deflate=True)
    batch.close()
    batch_files.append(bp)

    write_progress(progress, "saving", total, total)
    name = session.get("bookName") or "scan"
    _merge_batches(batch_files, out_pdf, {"title": name, "producer": "Straight Up – Scan Book"})

    ocr_json = os.path.join(out_dir, "ocr_results.json")
    with open(ocr_json, "w", encoding="utf-8") as f:
        json.dump(ocr_all, f, ensure_ascii=False)
    del ocr_all
    _build_searchable_pdf(out_pdf, ocr_json)
    if do_txt:
        _write_text_sidecar(ocr_json, os.path.join(out_dir, "ocr_text.txt"))
    if do_audit:
        try:
            write_progress(progress, "checking", 0, 0)
            from page_audit import audit_book
            rep = audit_book(out_pdf, out_dir, ocr_json)
            print(f"[audit] {rep['summary']}; {len(rep['issues'])} issue(s)", file=sys.stderr)
        except Exception as e:
            print(f"[audit] failed: {e}", file=sys.stderr)
    write_progress(progress, "done", total, total)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    prog = sys.argv[3]
    try:
        export(sys.argv[1], sys.argv[2], prog,
               do_txt=(sys.argv[4] == "1") if len(sys.argv) > 4 else True,
               do_audit=(sys.argv[5] == "1") if len(sys.argv) > 5 else False)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        with open(prog, "w") as f:
            json.dump({"phase": "error", "error": str(e), "current": 0, "total": 0}, f)
        sys.exit(1)
