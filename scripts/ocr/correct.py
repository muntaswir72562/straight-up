"""
Safe post-corrections for OCR output.

Only applies corrections that cannot change a real word:
  - Typographic apostrophes
  - Ligature decomposition (fi/fl ligatures → separate letters)
  - Hyphenated word joining across line breaks
  - l/I → 1 and O → 0 in tokens that are otherwise all digits
"""
import re


def correct_words(words):
    """Apply safe per-word corrections in place. Returns the same list."""
    for w in words:
        w['text'] = _fix_typography(w['text'])
        w['text'] = _fix_digit_confusion(w['text'])
    return words


def join_hyphenated(lines):
    """
    Join words hyphenated across line breaks.

    "plus-" at end of line + "ieurs" at start of next → "plusieurs".
    Only joins when the continuation starts with a lowercase letter.
    """
    for i in range(len(lines) - 1):
        cur_words = lines[i].get('words', [])
        next_words = lines[i + 1].get('words', [])
        if not cur_words or not next_words:
            continue
        last = cur_words[-1]
        first = next_words[0]
        if (last['text'].endswith('-')
                and len(last['text']) > 1
                and first['text']
                and first['text'][0].islower()):
            joined = last['text'][:-1] + first['text']
            last['text'] = joined
            first['text'] = ''
            first['_joined'] = True
    for line in lines:
        line['words'] = [w for w in line.get('words', []) if w.get('text')]
    return lines


def _fix_typography(text):
    """Replace straight apostrophes with typographic curly apostrophes
    and decompose fi/fl ligature characters."""
    if not text:
        return text
    # Straight apostrophe between letters → curly apostrophe (U+2019)
    text = re.sub(r"(?<=[a-zA-Z\u00C0-\u024F])'(?=[a-zA-Z\u00C0-\u024F])", '\u2019', text)
    # Decompose ligature characters (for searchability)
    text = text.replace('\ufb01', 'fi')
    text = text.replace('\ufb02', 'fl')
    return text


def _fix_digit_confusion(text):
    """Swap l/I → 1 and O → 0 only in tokens that are otherwise all digits."""
    if not text:
        return text
    # Must already contain at least one real digit (avoid "II" → "11")
    if not any(c.isdigit() for c in text):
        return text
    trial = text.replace('l', '1').replace('I', '1').replace('O', '0')
    if trial.isdigit() and not text.isdigit():
        return trial
    return text
