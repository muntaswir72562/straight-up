"""
Searchable PDF output shared by Full Book Fix (fullfix_pdf.py) and Scan Book
(scan_export.py): invisible OCR text layer + plain-text sidecar. Moved here
unchanged from fullfix_pdf.py.
"""

import json
import os
import sys

import fitz  # pymupdf


def _strip_old_text_layer(page):
    """Remove an existing invisible (OCR) text layer from a page before the
    new OCR text is written, so a book that already had OCR doesn't end up
    with every word twice. Only pages whose text is ALL invisible are
    touched; pages with visible text are left as they are. Images and
    drawings are kept."""
    try:
        spans = page.get_texttrace()
    except Exception:
        return False
    if not spans or any(s.get('type') != 3 for s in spans):
        return False
    try:
        page.add_redact_annot(page.rect, fill=False)
        try:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=getattr(fitz, 'PDF_REDACT_LINE_ART_NONE', 0))
        except TypeError:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        return True
    except Exception:
        return False


def _build_searchable_pdf(output_path, ocr_json_path):
    """Overlay invisible OCR text on the output PDF to make it searchable."""
    with open(ocr_json_path, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    doc = fitz.open(output_path)
    font = fitz.Font('helv')
    words_added = 0

    for page_data in ocr_data:
        pnum = page_data['page'] - 1
        if pnum >= len(doc):
            continue
        if page_data.get('error'):
            continue

        page = doc[pnum]
        pw = page.rect.width   # PDF points
        ph = page.rect.height
        iw = page_data['width']   # OCR pixel dimensions
        ih = page_data['height']
        if iw == 0 or ih == 0:
            continue
        sx = pw / iw  # pixel → points scale
        sy = ph / ih

        _strip_old_text_layer(page)
        tw = fitz.TextWriter(page.rect)

        for block in page_data.get('blocks', []):
            for line in block.get('lines', []):
                for word in line.get('words', []):
                    txt = word.get('text', '').strip()
                    if not txt:
                        continue
                    bx, by, bw, bh = word['bbox']
                    w_pt = bw * sx
                    h_pt = bh * sy
                    if w_pt < 1 or h_pt < 1:
                        continue

                    # Scale font so rendered width matches bbox width
                    fs = h_pt * 0.9
                    tl = font.text_length(txt, fontsize=fs)
                    if tl > 0:
                        fs = fs * (w_pt / tl)
                        fs = max(1.0, min(fs, h_pt))

                    x0 = bx * sx
                    baseline_y = by * sy + h_pt * 0.85

                    try:
                        tw.append(fitz.Point(x0, baseline_y), txt,
                                  fontsize=fs, font=font)
                        words_added += 1
                    except Exception:
                        pass

        tw.write_text(page, render_mode=3, color=(0, 0, 0))

    # Atomic save via temp file
    tmp_out = output_path + '.tmp'
    doc.save(tmp_out, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp_out, output_path)
    print(f"[fullfix] Searchable PDF: {words_added} words embedded",
          file=sys.stderr)


def _write_text_sidecar(ocr_json_path, txt_path):
    """Write plain-text sidecar from OCR results."""
    with open(ocr_json_path, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    with open(txt_path, 'w', encoding='utf-8') as out:
        for page_data in ocr_data:
            pnum = page_data['page']
            text = page_data.get('text', '')
            header = page_data.get('header', '')
            footer = page_data.get('footer', '')

            out.write(f'--- Page {pnum} ---\n')
            if header:
                out.write(header + '\n')
            if text:
                out.write(text + '\n')
            if footer:
                out.write(footer + '\n')
            out.write('\n')

    print(f"[fullfix] Text sidecar written: {txt_path}", file=sys.stderr)
