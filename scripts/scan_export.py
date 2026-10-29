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

    batch_files, batch, n_in_batch = [], fitz.open(), 0
    ocr_all = []
    for i, pid in enumerate(order, start=1):
        base = os.path.join(pages_dir, f"page_{pid}")
        with open(base + ".meta.json", encoding="utf-8") as f:
            meta = json.load(f)
        dpi = float(meta.get("dpi") or 300)
        w_pt, h_pt = meta["width"] / dpi * 72.0, meta["height"] / dpi * 72.0
        page = batch.new_page(width=w_pt, height=h_pt)
        page.insert_image(fitz.Rect(0, 0, w_pt, h_pt), filename=base + ".jpg")
        try:
            with open(base + ".ocr.json", encoding="utf-8") as f:
                ocr = json.load(f)
        except (OSError, ValueError):
            ocr = {"error": True, "blocks": [], "text": ""}
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
