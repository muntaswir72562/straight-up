#!/usr/bin/env python3
"""
Unit tests for page_audit.py.

Tests the pure-function audit logic (Steps B–E) without needing PDFs.
Run: python -m pytest scripts/test_page_audit.py -v
  or: python scripts/test_page_audit.py
"""

import sys
import os
import unittest
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from page_audit import (
    roman_to_int,
    int_to_roman,
    extract_candidates,
    learn_layout,
    pick_page_numbers,
    build_runs,
    analyse_run,
    detect_issues,
    check_duplicates,
    _text_ngrams,
    _image_correlation,
    is_blank_page,
)


# ── Helpers ──────────────────────────────────────────────────────────

def _make_word(text: str, x: int, y: int, w: int = 30, h: int = 12,
               conf: int = 90) -> dict:
    """Create a word dict with bbox [x, y, w, h]."""
    return {'text': text, 'conf': conf, 'bbox': [x, y, w, h]}


def _make_candidate(value: int, kind: str = 'arabic', band: str = 'bottom',
                    h_slot: str = 'centre', conf: int = 90,
                    weight: float = 1.0) -> dict:
    """Create a candidate dict."""
    if kind == 'roman':
        text = int_to_roman(value)
    else:
        text = str(value)
    return {
        'value': value,
        'kind': kind,
        'band': band,
        'h_slot': h_slot,
        'slot': f'{band}-{h_slot}',
        'conf': conf,
        'text': text,
        'weight': weight,
    }


def _simulate_book(page_numbers: list, kind: str = 'arabic',
                   slot: str = 'bottom-centre',
                   alternating: bool = False) -> list[list[dict]]:
    """
    Build candidates_per_page for a book with given page numbers.
    None means no number on that scan page.
    """
    band, h_slot = slot.split('-')
    candidates = []
    for i, pn in enumerate(page_numbers):
        if pn is None:
            candidates.append([])
        else:
            if alternating:
                # Odd scan pages → left, even → right
                hs = 'left' if (i + 1) % 2 == 1 else 'right'
            else:
                hs = h_slot
            candidates.append([_make_candidate(pn, kind, band, hs)])
    return candidates


def _run_full_pipeline(page_numbers: list, kind: str = 'arabic',
                       alternating: bool = False) -> tuple[list[dict], list[dict]]:
    """Run the full pipeline and return (all_pages, all_issues)."""
    candidates = _simulate_book(page_numbers, kind, alternating=alternating)
    layout = learn_layout(candidates)
    picked = pick_page_numbers(candidates, layout)
    runs = build_runs(picked)

    all_pages = []
    all_issues = []
    for run in runs:
        run_pages, smoothed = analyse_run(run)
        issues = detect_issues(run_pages, smoothed, run['kind'], run['from_scan'])
        all_pages.extend(run_pages)
        all_issues.extend(issues)

    return all_pages, all_issues


# ── Roman numeral tests ──────────────────────────────────────────────

class TestRomanNumerals(unittest.TestCase):
    def test_valid_conversions(self):
        self.assertEqual(roman_to_int('xiv'), 14)
        self.assertEqual(roman_to_int('iv'), 4)
        self.assertEqual(roman_to_int('i'), 1)
        self.assertEqual(roman_to_int('xlii'), 42)
        self.assertEqual(roman_to_int('mcmxcix'), 1999)

    def test_round_trip(self):
        for n in [1, 4, 9, 14, 42, 99, 100, 399, 1000]:
            s = int_to_roman(n)
            self.assertEqual(roman_to_int(s), n, f"Round-trip failed for {n}")

    def test_invalid_rejected(self):
        self.assertIsNone(roman_to_int('iiv'))
        self.assertIsNone(roman_to_int('vx'))
        self.assertIsNone(roman_to_int('abc'))
        self.assertIsNone(roman_to_int(''))
        self.assertIsNone(roman_to_int('IIII'))  # not standard

    def test_case_insensitive(self):
        self.assertEqual(roman_to_int('XIV'), 14)
        self.assertEqual(roman_to_int('Iv'), 4)


# ── Candidate extraction tests ───────────────────────────────────────

class TestExtractCandidates(unittest.TestCase):
    def test_arabic_bottom(self):
        words = [_make_word('42', 300, 950)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]['value'], 42)
        self.assertEqual(cands[0]['kind'], 'arabic')
        self.assertEqual(cands[0]['band'], 'bottom')

    def test_roman_top(self):
        words = [_make_word('xiv', 300, 50)]
        cands = extract_candidates(words, 600, 1000)
        roman_cands = [c for c in cands if c['kind'] == 'roman']
        self.assertEqual(len(roman_cands), 1)
        self.assertEqual(roman_cands[0]['value'], 14)

    def test_year_rejected(self):
        words = [_make_word('2014', 300, 950)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(len(cands), 0)

    def test_year_range_rejected(self):
        words = [_make_word('2014-15', 300, 50)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(len(cands), 0)

    def test_bracketed_ref_rejected(self):
        words = [_make_word('[696/1]', 500, 50)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(len(cands), 0)

    def test_middle_of_page_ignored(self):
        words = [_make_word('42', 300, 500)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(len(cands), 0)

    def test_page_prefix(self):
        words = [_make_word('Page 12', 300, 950)]
        cands = extract_candidates(words, 600, 1000)
        arabic = [c for c in cands if c['kind'] == 'arabic']
        self.assertEqual(len(arabic), 1)
        self.assertEqual(arabic[0]['value'], 12)

    def test_horizontal_slots(self):
        # Left
        words = [_make_word('10', 50, 950)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(cands[0]['h_slot'], 'left')

        # Right
        words = [_make_word('10', 500, 950)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(cands[0]['h_slot'], 'right')

        # Centre
        words = [_make_word('10', 280, 950)]
        cands = extract_candidates(words, 600, 1000)
        self.assertEqual(cands[0]['h_slot'], 'centre')

    def test_ocr_confusion_fix(self):
        words = [_make_word('l2', 300, 950)]
        cands = extract_candidates(words, 600, 1000)
        arabic = [c for c in cands if c['kind'] == 'arabic']
        self.assertEqual(len(arabic), 1)
        self.assertEqual(arabic[0]['value'], 12)

    def test_single_roman_letter_weak(self):
        words = [_make_word('i', 300, 950)]
        cands = extract_candidates(words, 600, 1000)
        roman = [c for c in cands if c['kind'] == 'roman']
        self.assertEqual(len(roman), 1)
        self.assertLess(roman[0]['weight'], 1.0)


# ── Layout learning tests ────────────────────────────────────────────

class TestLearnLayout(unittest.TestCase):
    def test_consistent_centre(self):
        cands = _simulate_book(list(range(1, 51)))
        layout = learn_layout(cands)
        self.assertFalse(layout['fallback'])

    def test_alternating_left_right(self):
        """Numbers alternate: odd pages → left, even pages → right."""
        cands = _simulate_book(list(range(1, 51)), alternating=True)
        layout = learn_layout(cands)
        self.assertFalse(layout['fallback'])
        # Odd pages should be in left, even in right
        if layout['odd'] is not None:
            self.assertIn('left', layout['odd'][0])
        if layout['even'] is not None:
            self.assertIn('right', layout['even'][0])


# ── Sequence analysis tests ──────────────────────────────────────────

class TestSequenceAnalysis(unittest.TestCase):
    def test_continuous_no_issues(self):
        """Continuous 1..50 → no issues."""
        _, issues = _run_full_pipeline(list(range(1, 51)))
        self.assertEqual(len(issues), 0)

    def test_missing_pages(self):
        """1..20, 23..50 → missing 21–22."""
        nums = list(range(1, 21)) + list(range(23, 51))
        _, issues = _run_full_pipeline(nums)
        missing = [i for i in issues if i['type'] == 'missing']
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]['printed'], ['21', '22'])

    def test_duplicate_same_text(self):
        """1..20, 20, 21..50 with identical text → duplicate high confidence."""
        nums = list(range(1, 21)) + [20] + list(range(21, 51))
        all_pages, issues = _run_full_pipeline(nums)
        dup = [i for i in issues if i['type'] == 'duplicate']
        self.assertGreaterEqual(len(dup), 1)

        # Build diverse text so each page has 15+ unique word trigrams
        texts = [
            (f'the court held that the defendant in case number {i} was '
             f'guilty of the offence charged under section {i + 100} of '
             f'the criminal code and sentenced the accused person to '
             f'imprisonment for a period not exceeding five years after '
             f'which the appeal was dismissed by the supreme court')
            for i in range(len(all_pages))
        ]
        # Make the duplicate pages have identical text
        dup_idx = 19  # scan page 20 (0-based)
        texts[dup_idx + 1] = texts[dup_idx]  # same text

        issues = check_duplicates(issues, all_pages, texts, None)
        dup = [i for i in issues if i['type'] == 'duplicate']
        high = [i for i in dup if i['confidence'] == 'high']
        self.assertGreaterEqual(len(high), 1)

    def test_duplicate_different_text(self):
        """1..20, 20, 21..50 with different text → duplicate low confidence."""
        nums = list(range(1, 21)) + [20] + list(range(21, 51))
        all_pages, issues = _run_full_pipeline(nums)
        dup = [i for i in issues if i['type'] == 'duplicate']
        self.assertGreaterEqual(len(dup), 1)

        # Different text on every page
        texts = [f'completely different content on page {i} with enough words to make ngrams'
                 for i in range(len(all_pages))]
        issues = check_duplicates(issues, all_pages, texts, None)
        dup = [i for i in issues if i['type'] == 'duplicate']
        # Should still be reported but with low confidence
        for d in dup:
            self.assertEqual(d['confidence'], 'low')

    def test_swapped_pages_no_issues(self):
        """1..10, 12, 11, 13..50 → no issues (smoothed away)."""
        nums = list(range(1, 11)) + [12, 11] + list(range(13, 51))
        _, issues = _run_full_pipeline(nums)
        # A one-page blip should be smoothed away
        missing = [i for i in issues if i['type'] == 'missing']
        self.assertEqual(len(missing), 0)

    def test_duplicate_and_missing(self):
        """1..20, 20, 22..50 → both duplicate 20 and missing 21."""
        nums = list(range(1, 21)) + [20] + list(range(22, 51))
        _, issues = _run_full_pipeline(nums)
        types = {i['type'] for i in issues}
        self.assertIn('duplicate', types)
        self.assertIn('missing', types)

    def test_roman_then_arabic(self):
        """i..xiv then 1..40 → two runs, no issues."""
        roman = list(range(1, 15))
        arabic = list(range(1, 41))
        cands = (_simulate_book(roman, 'roman') +
                 _simulate_book(arabic, 'arabic'))
        layout = learn_layout(cands)
        picked = pick_page_numbers(cands, layout)
        runs = build_runs(picked)

        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]['kind'], 'roman')
        self.assertEqual(runs[1]['kind'], 'arabic')

        all_issues = []
        for run in runs:
            rp, sm = analyse_run(run)
            all_issues.extend(detect_issues(rp, sm, run['kind'], run['from_scan']))
        self.assertEqual(len(all_issues), 0)

    def test_misreads_outvoted(self):
        """A year (1955) and a footnote (3) inside 40..80 → no issues."""
        nums = list(range(40, 81))
        # Replace some entries with junk values that would survive extraction
        nums[10] = 1955  # year-like value at index 10 (should be 50)
        nums[15] = 3     # footnote number at index 15 (should be 55)
        _, issues = _run_full_pipeline(nums)
        missing = [i for i in issues if i['type'] == 'missing']
        self.assertEqual(len(missing), 0)

    def test_chapter_openers_inferred(self):
        """Every 7th page unnumbered → inferred, no issues."""
        nums = []
        for i in range(1, 51):
            if i % 7 == 0:
                nums.append(None)
            else:
                nums.append(i)
        _, issues = _run_full_pipeline(nums)
        missing = [i for i in issues if i['type'] == 'missing']
        self.assertEqual(len(missing), 0)

    def test_same_text_far_apart_not_duplicate(self):
        """Same text on printed pages 41 and 164 → NOT a duplicate."""
        nums = list(range(1, 201))
        all_pages, issues = _run_full_pipeline(nums)
        # No numbering issues, but let's add a fake one and test the content check
        # Create a synthetic duplicate issue far apart
        fake_issue = {
            'type': 'duplicate',
            'confidence': 'low',
            'after_scan': 41,
            'before_scan': 164,
            'printed': [],
            'message': 'test',
        }
        texts = [f'unique content for page {i} with enough words to fill' for i in range(200)]
        # Make pages 41 and 164 identical
        texts[40] = texts[163] = ('the court held that section three of the act '
                                  'provides for the punishment of any person who '
                                  'obtains goods by false pretences and this is '
                                  'consistent with earlier jurisprudence')

        result = check_duplicates([fake_issue], all_pages, texts, None)
        # Should NOT be reported because pages are far apart with different numbers
        dup = [i for i in result if i['type'] == 'duplicate']
        self.assertEqual(len(dup), 0)


# ── Content check helper tests ───────────────────────────────────────

class TestContentHelpers(unittest.TestCase):
    def test_text_ngrams(self):
        text = "the quick brown fox jumps over the lazy dog"
        ngrams = _text_ngrams(text)
        self.assertGreater(len(ngrams), 0)
        self.assertIn(('the', 'quick', 'brown'), ngrams)

    def test_text_ngrams_short_words_excluded(self):
        text = "a b c the big cat sat on it"
        ngrams = _text_ngrams(text)
        # Only words with 3+ letters: 'the', 'big', 'cat', 'sat'
        # That's 4 words → 2 trigrams
        self.assertEqual(len(ngrams), 2)

    def test_image_correlation_identical(self):
        img = np.random.randint(0, 256, (96, 64), dtype=np.uint8)
        corr = _image_correlation(img, img)
        self.assertAlmostEqual(corr, 1.0, places=5)

    def test_image_correlation_different(self):
        img_a = np.zeros((96, 64), dtype=np.uint8)
        img_b = np.full((96, 64), 255, dtype=np.uint8)
        corr = _image_correlation(img_a, img_b)
        # Constant images → 0 correlation
        self.assertAlmostEqual(corr, 0.0, places=5)

    def test_blank_page_detection(self):
        blank = np.full((96, 64), 255, dtype=np.uint8)
        self.assertTrue(is_blank_page(blank))

        not_blank = np.full((96, 64), 50, dtype=np.uint8)
        self.assertFalse(is_blank_page(not_blank))


# ── Alternating layout tests ─────────────────────────────────────────

class TestAlternatingLayout(unittest.TestCase):
    def test_read_correctly(self):
        """Numbers alternating left/right by parity → read correctly."""
        _, issues = _run_full_pipeline(list(range(1, 51)), alternating=True)
        self.assertEqual(len(issues), 0)


# ── Entry point ──────────────────────────────────────────────────────

if __name__ == '__main__':
    unittest.main()
