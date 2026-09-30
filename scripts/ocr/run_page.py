#!/usr/bin/env python3
"""
CLI for testing single-page OCR.

Usage (from the scripts/ directory):
    python -m ocr.run_page <pdf> <page_no> [--v2] [--lang fra+eng]

Or from the project root:
    python scripts/ocr/run_page.py <pdf> <page_no> [--v2]

Prints the OCR JSON result and body text, and writes a debug PNG with
word bounding boxes colour-coded by confidence (green ≥ 70, yellow ≥ 40,
red < 40).
"""
import sys
import os
import json
import argparse

# Ensure scripts/ is on the path so scanner.* and ocr.* resolve
_scripts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

import cv2
import numpy as np
import fitz

from ocr.page import ocr_page

RENDER_DPI = 200


def main():
    parser = argparse.ArgumentParser(
        description='Test OCR on a single PDF page')
    parser.add_argument('pdf', help='Path to PDF file')
    parser.add_argument('page_no', type=int, help='Page number (1-based)')
    parser.add_argument('--v2', action='store_true',
                        help='Run scanner v2 pipeline before OCR')
    parser.add_argument('--lang', default='fra+eng',
                        help='Tesseract language(s) (default: fra+eng)')
    parser.add_argument('--output', '-o',
                        help='Output directory (default: same as PDF)')
    args = parser.parse_args()

    # ── Render page ─────────────────────────────────────────────────
    doc = fitz.open(args.pdf)
    if args.page_no < 1 or args.page_no > len(doc):
        print(f'Error: page {args.page_no} out of range (1-{len(doc)})',
              file=sys.stderr)
        sys.exit(1)

    page = doc[args.page_no - 1]
    pix = page.get_pixmap(dpi=RENDER_DPI)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
        pix.h, pix.w, pix.n).copy()
    n_ch = pix.n
    del pix

    if n_ch == 4:
        gray = cv2.cvtColor(img, cv2.COLOR_RGBA2GRAY)
    elif n_ch == 3:
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    else:
        gray = img.copy()
    del img

    # ── Optional v2 pipeline ────────────────────────────────────────
    if args.v2:
        from scanner.scan_page import process_page_v2
        gray = process_page_v2(gray, args.page_no, len(doc))

    doc.close()

    # ── OCR ─────────────────────────────────────────────────────────
    result = ocr_page(gray, page_num=args.page_no,
                      render_dpi=RENDER_DPI, lang=args.lang)

    # ── Print results ───────────────────────────────────────────────
    print(json.dumps(result, ensure_ascii=False, indent=2))

    print('\n--- TEXT ---', file=sys.stderr)
    print(result.get('text', ''), file=sys.stderr)

    if result.get('header'):
        print(f"\n--- HEADER ---\n{result['header']}", file=sys.stderr)
    if result.get('footer'):
        print(f"\n--- FOOTER ---\n{result['footer']}", file=sys.stderr)
    if result.get('page_number'):
        print(f"\n--- PAGE NUMBER ---\n{result['page_number']}",
              file=sys.stderr)

    for b in result.get('blocks', []):
        if b['type'] == 'table' and b.get('table'):
            rows = b['table']['rows']
            print(f'\n--- TABLE ({len(rows)} rows) ---', file=sys.stderr)
            for i, row in enumerate(rows):
                print(f'  row {i}: {row}', file=sys.stderr)

    # ── Debug PNG with word boxes ───────────────────────────────────
    out_dir = args.output or os.path.dirname(os.path.abspath(args.pdf)) or '.'
    debug_path = os.path.join(out_dir, f'ocr_debug_p{args.page_no}.png')

    debug_img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # Draw block bboxes in blue
    for block in result['blocks']:
        bx, by, bw, bh = block['bbox']
        label = block['type']
        if label == 'article':
            label += f" #{block.get('article_number', '?')}"
        cv2.rectangle(debug_img, (bx, by), (bx + bw, by + bh),
                      (255, 120, 0), 2)
        cv2.putText(debug_img, label, (bx, max(by - 4, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 120, 0), 1,
                    cv2.LINE_AA)

        for line in block.get('lines', []):
            for word in line.get('words', []):
                wx, wy, ww, wh = word['bbox']
                conf = word.get('conf', 0)
                if conf >= 70:
                    color = (0, 200, 0)      # green: high
                elif conf >= 40:
                    color = (0, 200, 200)    # yellow: medium
                else:
                    color = (0, 0, 200)      # red: low
                cv2.rectangle(debug_img, (wx, wy), (wx + ww, wy + wh),
                              color, 1)

    cv2.imwrite(debug_path, debug_img)
    print(f'\nDebug image written to: {debug_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
