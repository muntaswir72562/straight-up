"""
Layout-aware block detection using scanner layout info and Tesseract output.

Block types:
  - paragraph: normal body text
  - header: text above the body text area
  - footer: text below the body text area
  - page_number: a short number in header/footer area
  - article: paragraph starting with an article number pattern
  - table: rows x cols from per-cell OCR
  - contents: lines with dot leaders (TOC / tables of cases)
"""
import re


def build_blocks(words, lines_info, table_cells, page_h, page_w):
    """
    Build blocks from OCR words using scanner layout info.

    Args:
        words: list of word dicts from engine.extract_words
        lines_info: scanner.layout.Lines object, or None
        table_cells: list of (row_idx, col_idx, text, bbox) from table OCR, or []
        page_h, page_w: original image dimensions

    Returns:
        List of block dicts.
    """
    blocks = []

    # Table block (from per-cell OCR)
    table_bbox = None
    if table_cells:
        tb = _build_table_block(table_cells, page_h, page_w)
        blocks.append(tb)
        table_bbox = tb['bbox']

    # Group OCR words into Tesseract's block → paragraph → line hierarchy
    tess_lines = _group_into_lines(words)

    # Body region from the scanner's text-line analysis
    body_y0, body_y1 = _body_region(lines_info, page_h, page_w)

    # Group lines into paragraph-level blocks
    line_groups = _group_lines_into_paragraphs(tess_lines)

    for group in line_groups:
        block = _classify_block(group, body_y0, body_y1, page_h)
        if table_bbox and _overlaps_rect(block['bbox'], table_bbox, 0.5):
            continue  # skip words that Tesseract read inside the table area
        blocks.append(block)

    return blocks


# ── Tesseract hierarchy grouping ────────────────────────────────────

def _group_into_lines(words):
    """Group words into lines based on Tesseract block/par/line keys."""
    lines = {}
    for w in words:
        key = (w['block_num'], w['par_num'], w['line_num'])
        if key not in lines:
            lines[key] = {
                'words': [],
                'block_num': w['block_num'],
                'par_num': w['par_num'],
                'line_num': w['line_num'],
            }
        lines[key]['words'].append(w)

    result = []
    for key in sorted(lines.keys()):
        line = lines[key]
        ws = line['words']
        if not ws:
            continue
        x0 = min(w['bbox'][0] for w in ws)
        y0 = min(w['bbox'][1] for w in ws)
        x1 = max(w['bbox'][0] + w['bbox'][2] for w in ws)
        y1 = max(w['bbox'][1] + w['bbox'][3] for w in ws)
        line['bbox'] = [x0, y0, x1 - x0, y1 - y0]
        line['text'] = ' '.join(w['text'] for w in ws)
        result.append(line)
    return result


def _group_lines_into_paragraphs(tess_lines):
    """Group consecutive lines by Tesseract block_num + par_num."""
    groups = []
    current = []
    current_key = None
    for line in tess_lines:
        key = (line['block_num'], line['par_num'])
        if key != current_key:
            if current:
                groups.append(current)
            current = [line]
            current_key = key
        else:
            current.append(line)
    if current:
        groups.append(current)
    return groups


# ── Body region ─────────────────────────────────────────────────────

def _body_region(lines_info, page_h, page_w):
    """Determine the body text region (y0, y1) from the scanner's Lines."""
    if lines_info is None or len(lines_info.boxes) < 3:
        return 0, page_h

    boxes = lines_info.boxes
    long_mask = boxes[:, 2] > 0.3 * page_w
    core = boxes[long_mask] if long_mask.sum() >= 3 else boxes
    body_y0 = float(core[:, 1].min())
    body_y1 = float((core[:, 1] + core[:, 3]).max())
    return body_y0, body_y1


# ── Block classification ────────────────────────────────────────────

def _classify_block(lines, body_y0, body_y1, page_h):
    """Classify a group of lines by position and content."""
    if not lines:
        return {'type': 'paragraph', 'text': '', 'bbox': [0, 0, 0, 0], 'lines': []}

    x0 = min(l['bbox'][0] for l in lines)
    y0 = min(l['bbox'][1] for l in lines)
    x1 = max(l['bbox'][0] + l['bbox'][2] for l in lines)
    y1 = max(l['bbox'][1] + l['bbox'][3] for l in lines)
    bbox = [x0, y0, x1 - x0, y1 - y0]
    block_center_y = (y0 + y1) / 2
    text = '\n'.join(l['text'] for l in lines)

    out_lines = []
    for l in lines:
        out_lines.append({
            'text': l['text'],
            'bbox': l['bbox'],
            'words': [
                {'text': w['text'], 'conf': w['conf'], 'bbox': w['bbox']}
                for w in l['words']
            ],
        })

    block = {'text': text, 'bbox': bbox, 'lines': out_lines}

    # Margin around body for header/footer detection
    margin = max((body_y1 - body_y0) * 0.03, 5) if body_y1 > body_y0 else page_h * 0.02

    # Above body → header or page number
    if block_center_y < body_y0 - margin:
        block['type'] = 'page_number' if _is_page_number(text) else 'header'
        return block

    # Below body → footer or page number
    if block_center_y > body_y1 + margin:
        block['type'] = 'page_number' if _is_page_number(text) else 'footer'
        return block

    # Inside body: check for contents / article / plain paragraph
    if _is_contents_block(lines):
        block['type'] = 'contents'
        block['entries'] = _parse_contents(lines)
        return block

    article_num = _detect_article_number(lines)
    if article_num:
        block['type'] = 'article'
        block['article_number'] = article_num
    else:
        block['type'] = 'paragraph'
    return block


# ── Content-type detectors ──────────────────────────────────────────

def _is_page_number(text):
    """A page number is a short string that is mostly digits."""
    text = text.strip()
    cleaned = re.sub(r'[-\u2013\u2014.\s]', '', text)
    return 1 <= len(cleaned) <= 6 and cleaned.isdigit() and len(text) <= 12


def _detect_article_number(lines):
    """Detect an article number at the start of a block.

    Patterns: "1728.", "2125.", "Art. 682", "Article 682".
    """
    if not lines:
        return None
    first_text = lines[0]['text'].strip()
    m = re.match(r'^(\d{1,5})\.\s', first_text)
    if m:
        return m.group(1)
    m = re.match(r'^(?:Art(?:icle)?\.?\s*)(\d{1,5})', first_text, re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def _is_contents_block(lines):
    """Does this block look like contents / table-of-cases entries?"""
    if len(lines) < 1:
        return False
    dot_count = sum(
        1 for l in lines
        if re.search(r'[.\u00B7]{4,}', l['text']) or re.search(r'(\.\s){3,}', l['text'])
    )
    return dot_count >= max(1, len(lines) * 0.4)


def _parse_contents(lines):
    """Parse dot-leader lines into entry → page-number pairs."""
    entries = []
    for line in lines:
        text = line['text'].strip()
        m = re.match(r'^(.+?)\s*[.\u00B7\s]{4,}\s*(\d+)\s*$', text)
        if m:
            entries.append({'entry': m.group(1).strip(), 'page': m.group(2)})
        else:
            entries.append({'entry': text, 'page': None})
    return entries


# ── Table block ─────────────────────────────────────────────────────

def _build_table_block(table_cells, page_h, page_w):
    """Build a table block from per-cell OCR results."""
    if not table_cells:
        return {
            'type': 'table', 'text': '', 'bbox': [0, 0, 0, 0],
            'table': {'rows': []}, 'lines': [],
        }

    max_row = max(c[0] for c in table_cells) + 1
    max_col = max(c[1] for c in table_cells) + 1
    rows = [[''] * max_col for _ in range(max_row)]
    for row_idx, col_idx, text, _bbox in table_cells:
        rows[row_idx][col_idx] = text

    all_bboxes = [c[3] for c in table_cells if c[3]]
    if all_bboxes:
        x0 = min(b[0] for b in all_bboxes)
        y0 = min(b[1] for b in all_bboxes)
        x1 = max(b[0] + b[2] for b in all_bboxes)
        y1 = max(b[1] + b[3] for b in all_bboxes)
        bbox = [x0, y0, x1 - x0, y1 - y0]
    else:
        bbox = [0, 0, page_w, page_h]

    text = '\n'.join('\t'.join(row) for row in rows)
    return {
        'type': 'table', 'text': text, 'bbox': bbox,
        'table': {'rows': rows}, 'lines': [],
    }


# ── Geometry helpers ────────────────────────────────────────────────

def _overlaps_rect(bbox_a, bbox_b, threshold=0.5):
    """True if bbox_a overlaps bbox_b by at least `threshold` of A's area."""
    ax0, ay0, aw, ah = bbox_a
    bx0, by0, bw, bh = bbox_b
    ax1, ay1 = ax0 + aw, ay0 + ah
    bx1, by1 = bx0 + bw, by0 + bh

    ox0 = max(ax0, bx0)
    oy0 = max(ay0, by0)
    ox1 = min(ax1, bx1)
    oy1 = min(ay1, by1)
    if ox0 >= ox1 or oy0 >= oy1:
        return False

    overlap = (ox1 - ox0) * (oy1 - oy0)
    area_a = max(aw * ah, 1)
    return overlap > threshold * area_a
