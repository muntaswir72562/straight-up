"""
Tesseract OCR subprocess wrapper.

Runs the tesseract binary via stdin/stdout with no temp files.
Parses TSV output into structured word data.
"""
import csv
import io
import os
import shutil
import subprocess
import sys

import cv2

_TESSERACT_BIN = None


def _find_tesseract():
    """Find the tesseract binary, caching the result."""
    global _TESSERACT_BIN
    if _TESSERACT_BIN is not None:
        return _TESSERACT_BIN

    found = shutil.which('tesseract')
    if found:
        _TESSERACT_BIN = found
        return found

    if sys.platform == 'win32':
        for candidate in [
            os.path.join(os.environ.get('ProgramFiles', r'C:\Program Files'),
                         'Tesseract-OCR', 'tesseract.exe'),
            os.path.join(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'),
                         'Tesseract-OCR', 'tesseract.exe'),
        ]:
            if os.path.isfile(candidate):
                _TESSERACT_BIN = candidate
                return candidate

    _TESSERACT_BIN = 'tesseract'
    return _TESSERACT_BIN


def run_tesseract(gray, lang='fra+eng', psm=4, dpi=200, timeout=120):
    """
    Run Tesseract on a grayscale image via subprocess (stdin/stdout, no temp files).

    Args:
        gray: grayscale numpy array (H, W), uint8
        lang: Tesseract language string
        psm: page segmentation mode
        dpi: image resolution hint for Tesseract
        timeout: subprocess timeout in seconds

    Returns:
        List of parsed TSV row dicts (all levels).
    """
    ok, png_buf = cv2.imencode('.png', gray)
    if not ok:
        raise RuntimeError('Failed to encode image as PNG')

    tess_bin = _find_tesseract()
    cmd = [
        tess_bin, 'stdin', 'stdout',
        '-l', lang,
        '--oem', '1',
        '--psm', str(psm),
        '-c', 'tessedit_create_tsv=1',
        '--dpi', str(int(dpi)),
    ]

    try:
        result = subprocess.run(
            cmd,
            input=png_buf.tobytes(),
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError(
            'tesseract binary not found. '
            'Install tesseract-ocr (apt-get install tesseract-ocr).'
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'Tesseract timed out after {timeout}s')

    if result.returncode != 0:
        stderr = result.stderr.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'Tesseract exited with code {result.returncode}: {stderr}')

    return _parse_tsv(result.stdout.decode('utf-8', errors='replace'))


def _parse_tsv(tsv_text):
    """Parse Tesseract TSV output into a list of row dicts."""
    rows = []
    reader = csv.DictReader(io.StringIO(tsv_text), delimiter='\t')
    for row in reader:
        try:
            rows.append({
                'level': int(row['level']),
                'block_num': int(row['block_num']),
                'par_num': int(row['par_num']),
                'line_num': int(row['line_num']),
                'word_num': int(row['word_num']),
                'left': int(row['left']),
                'top': int(row['top']),
                'width': int(row['width']),
                'height': int(row['height']),
                'conf': int(float(row['conf'])),
                'text': row.get('text', '').strip(),
            })
        except (ValueError, KeyError):
            continue
    return rows


def extract_words(tsv_rows, scale=1.0):
    """
    Extract word-level data from parsed TSV rows.

    Divides bounding boxes by `scale` to convert from upscaled pixels
    back to the original page-image pixel coordinates.

    Returns:
        List of word dicts: text, conf, bbox [x, y, w, h],
        block_num, par_num, line_num, word_num.
    """
    words = []
    inv = 1.0 / scale if scale != 1.0 else 1.0
    for row in tsv_rows:
        if row['level'] != 5:
            continue
        text = row['text']
        if not text:
            continue
        conf = row['conf']
        if conf < 0:
            continue
        words.append({
            'text': text,
            'conf': conf,
            'bbox': [
                int(row['left'] * inv),
                int(row['top'] * inv),
                int(row['width'] * inv),
                int(row['height'] * inv),
            ],
            'block_num': row['block_num'],
            'par_num': row['par_num'],
            'line_num': row['line_num'],
            'word_num': row['word_num'],
        })
    return words
