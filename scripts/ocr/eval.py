"""
OCR accuracy evaluation — CER, WER, confidence calibration.

Usage:
    # Full evaluation against ground truth directory
    python -m ocr.eval --ocr-json results.json --ground-truth-dir ground_truth/

    # Confidence calibration only (no ground truth needed)
    python -m ocr.eval --ocr-json results.json --confidence-only

    # Single page evaluation
    python -m ocr.eval --ocr-json results.json --ground-truth ground_truth/page_0002.txt --page 2
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from statistics import mean, median

from rapidfuzz.distance import Levenshtein


# ── Text normalization ───────────────────────────────────────────────

def _normalize(text: str) -> str:
    """Normalize text for fair comparison."""
    # Unicode NFC
    text = unicodedata.normalize('NFC', text)
    # Remove soft hyphens
    text = text.replace('\u00ad', '')
    # Normalize typographic quotes/apostrophes to ASCII
    text = text.replace('\u2018', "'").replace('\u2019', "'")
    text = text.replace('\u201c', '"').replace('\u201d', '"')
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


# ── Metrics ──────────────────────────────────────────────────────────

def compute_cer(ocr_text: str, ref_text: str) -> tuple[float, int, int]:
    """Character Error Rate = edit_distance(ocr, ref) / len(ref)."""
    ocr = _normalize(ocr_text)
    ref = _normalize(ref_text)
    if not ref:
        return (0.0, 0, 0)
    dist = Levenshtein.distance(ocr, ref)
    return (dist / len(ref), dist, len(ref))


def compute_wer(ocr_text: str, ref_text: str) -> tuple[float, int, int]:
    """Word Error Rate = edit_distance(ocr_words, ref_words) / len(ref_words)."""
    ocr_words = _normalize(ocr_text).split()
    ref_words = _normalize(ref_text).split()
    if not ref_words:
        return (0.0, 0, 0)
    dist = Levenshtein.distance(ocr_words, ref_words)
    return (dist / len(ref_words), dist, len(ref_words))


# ── Error analysis ───────────────────────────────────────────────────

def error_analysis(ocr_text: str, ref_text: str) -> dict:
    """Align words and collect substitutions, insertions, deletions."""
    ocr_words = _normalize(ocr_text).split()
    ref_words = _normalize(ref_text).split()

    sm = SequenceMatcher(None, ocr_words, ref_words)
    subs: list[tuple[str, str]] = []
    insertions: list[str] = []
    deletions: list[str] = []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue
        elif tag == 'replace':
            for o, r in zip(ocr_words[i1:i2], ref_words[j1:j2]):
                subs.append((o, r))
            # Handle length mismatches in replace blocks
            extra_ocr = ocr_words[i1 + (j2 - j1):i2]
            extra_ref = ref_words[j1 + (i2 - i1):j2]
            deletions.extend(extra_ocr)
            insertions.extend(extra_ref)
        elif tag == 'insert':
            insertions.extend(ref_words[j1:j2])
        elif tag == 'delete':
            deletions.extend(ocr_words[i1:i2])

    sub_counts = Counter(subs)

    return {
        'substitutions': len(subs),
        'insertions': len(insertions),
        'deletions': len(deletions),
        'top_substitutions': sub_counts.most_common(15),
        'insertion_samples': insertions[:10],
        'deletion_samples': deletions[:10],
    }


# ── Confidence calibration ───────────────────────────────────────────

def confidence_report(ocr_data: list[dict]) -> str:
    """Analyze word confidence distribution across all pages."""
    buckets: dict[str, list[str]] = {
        '[90-100]': [],
        '[70-90)': [],
        '[40-70)': [],
        '[0-40)': [],
    }
    all_confs: list[int] = []

    for page in ocr_data:
        for block in page.get('blocks', []):
            for line in block.get('lines', []):
                for word in line.get('words', []):
                    conf = word.get('conf', -1)
                    txt = word.get('text', '')
                    if conf < 0 or not txt.strip():
                        continue
                    all_confs.append(conf)
                    if conf >= 90:
                        buckets['[90-100]'].append(txt)
                    elif conf >= 70:
                        buckets['[70-90)'].append(txt)
                    elif conf >= 40:
                        buckets['[40-70)'].append(txt)
                    else:
                        buckets['[0-40)'].append(txt)

    total = len(all_confs)
    if total == 0:
        return 'No words found.\n'

    lines = ['\n=== Confidence Calibration ===\n']
    lines.append(f'{"Bucket":<12} {"Count":>6} {"%":>7}   Sample words')
    lines.append('-' * 70)

    for bucket_name in ['[90-100]', '[70-90)', '[40-70)', '[0-40)']:
        words = buckets[bucket_name]
        count = len(words)
        pct = count / total * 100
        # Show up to 5 unique sample words
        samples = []
        seen = set()
        for w in words:
            if w not in seen and len(samples) < 5:
                samples.append(w)
                seen.add(w)
        sample_str = ', '.join(samples)
        if len(sample_str) > 40:
            sample_str = sample_str[:40] + '...'
        lines.append(f'{bucket_name:<12} {count:>6} {pct:>6.1f}%   {sample_str}')

    lines.append('')
    lines.append(f'Total: {total} words, '
                 f'mean_conf={mean(all_confs):.1f}, '
                 f'median_conf={median(all_confs):.0f}')
    lines.append('')
    return '\n'.join(lines)


# ── Report generation ────────────────────────────────────────────────

def run_evaluation(ocr_data: list[dict], gt_dir: str | None = None,
                   gt_file: str | None = None, page_num: int | None = None) -> str:
    """Run full evaluation and return formatted report."""
    lines: list[str] = []

    # Determine which pages have ground truth
    gt_pages: dict[int, str] = {}  # page_num -> ground truth text

    if gt_file and page_num:
        with open(gt_file, 'r', encoding='utf-8') as f:
            gt_pages[page_num] = f.read()
    elif gt_dir and os.path.isdir(gt_dir):
        for fname in sorted(os.listdir(gt_dir)):
            if fname.startswith('page_') and fname.endswith('.txt'):
                pnum_str = fname.replace('page_', '').replace('.txt', '')
                try:
                    pnum = int(pnum_str)
                except ValueError:
                    continue
                path = os.path.join(gt_dir, fname)
                with open(path, 'r', encoding='utf-8') as f:
                    gt_pages[pnum] = f.read()

    if gt_pages:
        lines.append('=== OCR Accuracy Report ===\n')
        lines.append('Per-page results:')

        total_cer_dist = 0
        total_cer_chars = 0
        total_wer_dist = 0
        total_wer_words = 0
        all_errors = error_analysis('', '')  # empty init

        page_results = []

        for page_data in ocr_data:
            pnum = page_data['page']
            if pnum not in gt_pages:
                continue

            ocr_text = page_data.get('text', '')
            header = page_data.get('header', '')
            footer = page_data.get('footer', '')
            full_ocr = '\n'.join(filter(None, [header, ocr_text, footer]))

            ref_text = gt_pages[pnum]

            cer, cer_dist, cer_chars = compute_cer(full_ocr, ref_text)
            wer, wer_dist, wer_words = compute_wer(full_ocr, ref_text)

            total_cer_dist += cer_dist
            total_cer_chars += cer_chars
            total_wer_dist += wer_dist
            total_wer_words += wer_words

            lines.append(f'  Page {pnum:>3}:  CER={cer*100:.1f}%  WER={wer*100:.1f}%  '
                         f'({cer_chars} chars, {wer_words} words)')

            page_results.append((pnum, full_ocr, ref_text))

        # Aggregate
        lines.append('')
        if total_cer_chars > 0:
            agg_cer = total_cer_dist / total_cer_chars
            lines.append(f'Aggregate CER = {agg_cer*100:.1f}%  '
                         f'({total_cer_dist} errors / {total_cer_chars} chars)')
        if total_wer_words > 0:
            agg_wer = total_wer_dist / total_wer_words
            lines.append(f'Aggregate WER = {agg_wer*100:.1f}%  '
                         f'({total_wer_dist} errors / {total_wer_words} words)')

        # Error analysis across all pages
        if page_results:
            combined_ocr = '\n'.join(ocr for _, ocr, _ in page_results)
            combined_ref = '\n'.join(ref for _, _, ref in page_results)
            errors = error_analysis(combined_ocr, combined_ref)

            lines.append(f'\nError breakdown:')
            lines.append(f'  Substitutions: {errors["substitutions"]}')
            lines.append(f'  Insertions:    {errors["insertions"]}')
            lines.append(f'  Deletions:     {errors["deletions"]}')

            if errors['top_substitutions']:
                lines.append(f'\nTop substitutions (OCR -> Reference):')
                for (ocr_w, ref_w), count in errors['top_substitutions']:
                    lines.append(f'  "{ocr_w}" -> "{ref_w}"  (x{count})')

            if errors['deletion_samples']:
                lines.append(f'\nSample deletions (extra in OCR):')
                for w in errors['deletion_samples']:
                    lines.append(f'  "{w}"')

            if errors['insertion_samples']:
                lines.append(f'\nSample insertions (missing from OCR):')
                for w in errors['insertion_samples']:
                    lines.append(f'  "{w}"')

        lines.append('')

    # Confidence calibration (always runs)
    lines.append(confidence_report(ocr_data))

    return '\n'.join(lines)


# ── CLI ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='OCR accuracy evaluation — CER, WER, confidence calibration')
    parser.add_argument('--ocr-json', required=True,
                        help='Path to ocr_results.json')
    parser.add_argument('--ground-truth-dir',
                        help='Directory with page_NNNN.txt ground truth files')
    parser.add_argument('--ground-truth',
                        help='Single ground truth file (use with --page)')
    parser.add_argument('--page', type=int,
                        help='Page number for single-file ground truth')
    parser.add_argument('--confidence-only', action='store_true',
                        help='Skip CER/WER, only show confidence calibration')
    parser.add_argument('--output', '-o',
                        help='Write report to file (default: stdout)')

    args = parser.parse_args()

    with open(args.ocr_json, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)

    if args.confidence_only:
        report = confidence_report(ocr_data)
    else:
        report = run_evaluation(
            ocr_data,
            gt_dir=args.ground_truth_dir,
            gt_file=args.ground_truth,
            page_num=args.page,
        )

    if args.output:
        os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f'Report written to {args.output}')
    else:
        print(report)


if __name__ == '__main__':
    main()
