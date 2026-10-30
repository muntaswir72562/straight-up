#!/usr/bin/env python3
"""
Tests for scanner/capture.py (Scan Book).

The fixtures are synthetic overhead-camera frames (text pages on a dark pad,
shaded gutter, LED colour cast, skin-coloured fingers, the grey "A1" thumb
tab), built with pymupdf + OpenCV, so the tests run anywhere.

Real IRIScan photos are tested too when present (the folder is gitignored):
  scripts/test_pages/scan/cover*.jpg          front cover        -> not split
  scripts/test_pages/scan/loose*.jpg          single loose page  -> not split
  scripts/test_pages/scan/spread_flat*.jpg    flat spread        -> split
  scripts/test_pages/scan/spread_curved*.jpg  curved spine       -> split
  scripts/test_pages/scan/fingers*.jpg        spread with fingers -> split, no skin on the borders
  scripts/test_pages/scan/tab*.jpg            page with the A1 tab -> tab untouched

Run: python -m pytest scripts/test_scan_capture.py -v
  or: python scripts/test_scan_capture.py
"""

import glob
import os
import shutil
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fitz  # noqa: E402

from scanner.capture import (  # noqa: E402
    Options, detect_spine, find_book_region, process_capture, remove_fingers,
    skin_mask, split_spread, white_balance,
)
from scanner.scan_page import process_page_v2_bgr  # noqa: E402

REAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_pages", "scan")

TEXT = ("The Copyright, Designs and Patents Act 1988 makes provision in respect of copyright "
        "and related rights. Section {n} applies where a work is made by an employee in the "
        "course of his employment, subject to any agreement to the contrary. ")

PAD = (28, 26, 24)          # dark pad, BGR
LED = (1.0, 0.96, 0.88)     # bluish LED cast, BGR gains
SKIN = (118, 148, 206)      # BGR


# ── Fixtures ─────────────────────────────────────────────────────────

def text_page(n, w=500, h=760, dpi=150, columns=1):
    """Rendered text page (BGR). Default size: a law book page at 150 dpi."""
    d = fitz.open()
    p = d.new_page(width=w, height=h)
    p.insert_textbox(fitz.Rect(50, 40, w - 50, 70), f"CHAPTER {n}", fontsize=14, align=1)
    if columns == 1:
        p.insert_textbox(fitz.Rect(50, 90, w - 50, h - 60), TEXT.format(n=n) * 12, fontsize=10)
    else:
        mid = w / 2
        p.insert_textbox(fitz.Rect(50, 90, mid - 30, h - 60), TEXT.format(n=n) * 8, fontsize=10)
        p.insert_textbox(fitz.Rect(mid + 30, 90, w - 50, h - 60), TEXT.format(n=n) * 8, fontsize=10)
    p.insert_textbox(fitz.Rect(50, h - 40, w - 50, h - 25), str(n), fontsize=9, align=1)
    pix = p.get_pixmap(dpi=dpi)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3][:, :, ::-1].copy()


def on_pad(img, frame=(2400, 3200), seed=0):
    """Place an image on the dark pad, with the LED cast and sensor noise."""
    H, W = frame
    out = np.empty((H, W, 3), np.float32)
    out[:] = PAD
    h, w = img.shape[:2]
    y, x = (H - h) // 2, (W - w) // 2
    out[y:y + h, x:x + w] = img
    out *= np.array(LED, np.float32)
    out += np.random.default_rng(seed).normal(0, 3, out.shape)
    return np.clip(out, 0, 255).astype(np.uint8), (x, y)


def spread(gutter_depth=0.35, columns=1):
    """Two pages side by side with a shaded gutter. Returns (img, spine_x)."""
    left, right = text_page(10, columns=columns), text_page(11, columns=columns)
    img = np.hstack([left, right]).astype(np.float32)
    w = img.shape[1]
    sx = left.shape[1]
    xs = np.arange(w, dtype=np.float32)
    shade = 1.0 - gutter_depth * np.exp(-((xs - sx) / (0.025 * w)) ** 2)
    img *= shade[None, :, None]
    return np.clip(img, 0, 255).astype(np.uint8), sx


def curve(img, tilt=0.04, bow=30.0):
    """Shift each row: spine at x0 + dx(y), dx = tilt*(y-h/2) + bow*((y-h/2)/(h/2))^2."""
    h, w = img.shape[:2]
    yc = np.arange(h, dtype=np.float32) - h / 2
    dx = tilt * yc + bow * (yc / (h / 2)) ** 2
    pad = int(np.abs(dx).max()) + 2
    big = cv2.copyMakeBorder(img, 0, 0, pad, pad, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    ys, xs = np.mgrid[0:h, 0:big.shape[1]].astype(np.float32)
    out = cv2.remap(big, xs - dx[:, None], ys, cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    return out, dx, pad


def draw_finger(img, cx, cy, ax, ay, angle):
    """A finger: shaded skin-coloured ellipse with a fingernail."""
    m = np.zeros(img.shape[:2], np.uint8)
    cv2.ellipse(m, (cx, cy), (ax, ay), angle, 0, 360, 255, -1)
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    shade = 0.75 + 0.25 * np.clip(dist / max(1.0, dist.max()), 0, 1)
    f = img.astype(np.float32)
    sk = np.array(SKIN, np.float32)
    f[m > 0] = sk * shade[m > 0][:, None]
    return np.clip(f, 0, 255).astype(np.uint8), m > 0


def edge_tab(page, side="right"):
    """Grey thumb-index tab on the outer edge with white text. Returns (page, tab mask)."""
    h, w = page.shape[:2]
    tw, th = int(0.07 * w), int(0.42 * h)
    y0 = int(0.12 * h)
    x0 = w - tw if side == "right" else 0
    out = page.copy()
    out[y0:y0 + th, x0:x0 + tw] = (78, 78, 78)
    label = np.zeros((tw, th, 3), np.uint8)
    label[:] = (78, 78, 78)
    cv2.putText(label, "A1 COPYRIGHT, DESIGNS AND PATENTS ACT 1988", (8, int(tw * 0.62)),
                cv2.FONT_HERSHEY_SIMPLEX, tw / 95.0, (250, 250, 250), 1, cv2.LINE_AA)
    out[y0:y0 + th, x0:x0 + tw] = cv2.rotate(label, cv2.ROTATE_90_CLOCKWISE)
    mask = np.zeros((h, w), bool)
    mask[y0:y0 + th, x0:x0 + tw] = True
    return out, mask


def cover(w=1050, h=1580):
    """Portrait front cover: dark red board, gold title."""
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (38, 30, 132)
    cv2.rectangle(img, (60, 60), (w - 60, h - 60), (70, 170, 210), 6)
    for i, t in enumerate(["COPYRIGHT", "DESIGNS AND", "PATENTS", "2024 EDITION"]):
        cv2.putText(img, t, (130, 420 + i * 170), cv2.FONT_HERSHEY_TRIPLEX, 2.4, (70, 170, 210), 5, cv2.LINE_AA)
    return img


# ── Tests ────────────────────────────────────────────────────────────

class TestCrop(unittest.TestCase):
    def test_crop_finds_page_on_pad(self):
        page = text_page(1)
        frame, (x, y) = on_pad(page)
        (x0, y0, x1, y1), conf = find_book_region(frame)
        self.assertGreater(conf, 0.5)
        h, w = page.shape[:2]
        tol = 0.03 * max(frame.shape[:2])
        self.assertLess(abs(x0 - x), tol)
        self.assertLess(abs(y0 - y), tol)
        self.assertLess(abs(x1 - (x + w)), tol)
        self.assertLess(abs(y1 - (y + h)), tol)
        # the margin never cuts into the page
        self.assertLessEqual(x0, x); self.assertLessEqual(y0, y)
        self.assertGreaterEqual(x1, x + w); self.assertGreaterEqual(y1, y + h)

    def test_no_pad_keeps_full_frame(self):
        page = text_page(1)
        (x0, y0, x1, y1), conf = find_book_region(page)
        self.assertEqual(conf, 0.0)
        self.assertEqual((x0, y0, x1, y1), (0, 0, page.shape[1], page.shape[0]))


class TestSpine(unittest.TestCase):
    def test_cover_not_split(self):
        self.assertFalse(detect_spine(cover()).spread)

    def test_single_portrait_page_not_split(self):
        self.assertFalse(detect_spine(text_page(3)).spread)

    def test_landscape_two_column_sheet_not_split(self):
        # text-free band in the middle and text on both sides, but no gutter
        # shading: a loose landscape sheet, not a book
        sheet = text_page(4, w=1000, h=700, columns=2)
        self.assertFalse(detect_spine(sheet).spread)

    def test_flat_spread_split_at_spine(self):
        img, sx = spread()
        sp = detect_spine(img)
        self.assertTrue(sp.spread, sp.reason)
        h = img.shape[0]
        for y in (0.2 * h, 0.5 * h, 0.8 * h):
            self.assertLess(abs(np.polyval(sp.spine, y) - sx), 6, sp.reason)

    def test_curved_spine_followed(self):
        img, sx = spread()
        img, dx, pad = curve(img, tilt=0.04, bow=28)
        sp = detect_spine(img)
        self.assertTrue(sp.spread, sp.reason)
        h = img.shape[0]
        for fy in (0.15, 0.3, 0.5, 0.7, 0.85):
            y = int(fy * h)
            true_x = sx + pad + dx[y]
            self.assertLess(abs(np.polyval(sp.spine, y) - true_x), 8,
                            f"y={y} fit={np.polyval(sp.spine, y):.1f} true={true_x:.1f}")

    def test_split_cuts_no_letters(self):
        img, sx = spread()
        sp = detect_spine(img)
        left, right = split_spread(img, sp.spine)
        lp = text_page(10)
        # every ink pixel of the left page survives in the left half (same coords)
        ink_l = cv2.cvtColor(lp, cv2.COLOR_BGR2GRAY) < 128
        self.assertGreaterEqual(left.shape[1], lp.shape[1] - 2)
        lg = cv2.cvtColor(left[:, :lp.shape[1]], cv2.COLOR_BGR2GRAY)
        lost = ink_l[:, :lg.shape[1]] & (lg > 200)
        self.assertEqual(int(lost.sum()), 0)
        # and the right page starts within the right half
        off = img.shape[1] - right.shape[1]
        self.assertLessEqual(off, sx)


class TestFingers(unittest.TestCase):
    def _fingers_page(self):
        page = text_page(5)
        h, w = page.shape[:2]
        page, m1 = draw_finger(page, int(0.4 * w), h - 5, int(0.035 * w), int(0.07 * h), 0)
        page, m2 = draw_finger(page, w - 5, int(0.6 * h), int(0.08 * w), int(0.03 * h), 0)
        return (page.astype(np.float32) * np.array(LED, np.float32)).astype(np.uint8), m1 | m2

    def test_fingers_removed(self):
        page, fm = self._fingers_page()
        before = int((skin_mask(white_balance(page)) > 0).sum())
        out, warn = remove_fingers(page, "1")
        after = int((skin_mask(white_balance(out)) > 0).sum())
        self.assertGreater(before, 1000)
        self.assertLess(after, 0.02 * before)
        # filled area looks like paper
        self.assertGreater(float(cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)[fm].mean()), 180)

    def test_text_away_from_fingers_untouched(self):
        page, fm = self._fingers_page()
        out, _ = remove_fingers(page, "1")
        far = ~(cv2.dilate(fm.astype(np.uint8), np.ones((81, 81), np.uint8)) > 0)
        self.assertTrue(np.array_equal(out[far], page[far]))

    def test_finger_over_text_warns(self):
        page = text_page(6)
        h, w = page.shape[:2]
        # finger reaching from the left border well into a text line block
        page, fm = draw_finger(page, 0, int(0.35 * h), int(0.14 * w), int(0.025 * h), 0)
        out, warn = remove_fingers(page, "7")
        self.assertEqual(warn, ["finger over text on page 7"])
        # letters next to the finger are kept
        ring = (cv2.dilate(fm.astype(np.uint8), np.ones((25, 25), np.uint8)) > 0) & ~(
            cv2.dilate(fm.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
        g0 = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
        g1 = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)
        ink = ring & (g0 < 100)
        self.assertGreater(int(ink.sum()), 20)
        self.assertGreater(float((g1[ink] < 128).mean()), 0.9)

    def test_gutter_shadow_not_a_finger(self):
        # warm grey gutter shadow along the spine side of a left page (colour
        # measured on an IRIScan photo): neither the spine side nor this
        # colour may be taken for a finger
        page = text_page(9).astype(np.float32)
        h, w = page.shape[:2]
        ramp = np.clip((np.arange(w) - 0.93 * w) / (0.07 * w), 0, 1)[None, :, None]
        shadow = np.array([139, 149, 169], np.float32)
        page = (page * (1 - ramp) + shadow * ramp).astype(np.uint8)
        for gutter in ("right", None):
            out, warn = remove_fingers(page, "1", gutter)
            self.assertEqual(warn, [])
            self.assertTrue(np.array_equal(out, page), gutter)

    def test_edge_tab_untouched(self):
        page, tab = edge_tab(text_page(7))
        page = (page.astype(np.float32) * np.array(LED, np.float32)).astype(np.uint8)
        out, warn = remove_fingers(page, "1")
        self.assertTrue(np.array_equal(out[tab], page[tab]))
        self.assertEqual(warn, [])

    def test_edge_tab_untouched_with_finger_nearby(self):
        page, tab = edge_tab(text_page(8))
        h, w = page.shape[:2]
        page, fm = draw_finger(page, w - 5, int(0.75 * h), int(0.08 * w), int(0.03 * h), 0)
        out, _ = remove_fingers(page, "1")
        self.assertTrue(np.array_equal(out[tab], page[tab]))
        self.assertLess(int((skin_mask(white_balance(out)) > 0).sum()), 0.02 * fm.sum())


class TestDewarp(unittest.TestCase):
    def test_flat_page_not_bent(self):
        page = text_page(9, dpi=200)
        out = process_page_v2_bgr(page.copy())
        self.assertEqual(out.shape, page.shape)
        diff = np.abs(out.astype(np.int16) - page.astype(np.int16))
        self.assertLess(float(diff.mean()), 1.0)


class TestPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="scan_test_")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, frame, cap, **opts):
        raw = os.path.join(self.tmp, f"capture_{cap:04d}.jpg")
        cv2.imwrite(raw, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return process_capture(raw, os.path.join(self.tmp, "pages"), cap, Options.from_dict(opts))

    def test_spread_gives_two_pages_with_text(self):
        img, _ = spread()
        frame, _ = on_pad(img, frame=(1900, 2600))
        pages = self._run(frame, 1)
        self.assertEqual(len(pages), 2)
        for p in pages:
            self.assertGreater(p["ocr_words"], 50)
            for ext in (".jpg", ".ocr.json", ".meta.json"):
                self.assertTrue(os.path.isfile(os.path.join(self.tmp, "pages", f"page_{p['id']}{ext}")))
        self.assertLess(pages[0]["width"], 0.65 * frame.shape[1])

    def test_cover_one_page_kept_colour(self):
        frame, _ = on_pad(cover(), frame=(2000, 1600))
        pages = self._run(frame, 2, color_mode="clean")
        self.assertEqual(len(pages), 1)
        self.assertTrue(pages[0]["colour"])

    def test_per_page_options(self):
        # spread: left page cleaned, right page kept in colour without dewarp
        img, _ = spread()
        frame, _ = on_pad(img, frame=(1900, 2600))
        pages = self._run(frame, 4, color_mode="clean",
                          per_page={"2": {"color_mode": "colour", "dewarp": False}})
        self.assertEqual(len(pages), 2)
        self.assertFalse(pages[0]["colour"])
        self.assertTrue(pages[1]["colour"])
        self.assertEqual(pages[0]["page_options"], {"color_mode": "clean", "dewarp": True, "remove_fingers": True})
        self.assertEqual(pages[1]["page_options"], {"color_mode": "colour", "dewarp": False, "remove_fingers": True})

    def test_manual_crop(self):
        # crop drawn around the left page of a spread only -> one page
        img, sx = spread()
        frame, (x, y) = on_pad(img, frame=(1900, 2600))
        H, W = frame.shape[:2]
        crop = {"x": x / W, "y": y / H, "w": sx / W, "h": img.shape[0] / H}
        pages = self._run(frame, 5, crop=crop, split="auto", dewarp=False)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["crop"]["source"], "manual")
        x0, y0, x1, y1 = pages[0]["crop"]["box"]
        self.assertLess(abs(x0 - x), 2)
        self.assertLess(abs((x1 - x0) - sx), 2)
        # crop around the whole spread -> still split at the spine
        crop = {"x": x / W, "y": y / H, "w": img.shape[1] / W, "h": img.shape[0] / H}
        self.assertEqual(len(self._run(frame, 6, crop=crop, dewarp=False)), 2)

    def test_bad_crop_ignored(self):
        o = Options.from_dict({"crop": {"x": 0.5, "y": 0.5, "w": 0.01, "h": 0.3}})
        self.assertIsNone(o.crop)
        o = Options.from_dict({"crop": {"x": 0.8, "y": 0.1, "w": 0.5, "h": 0.5}})
        self.assertAlmostEqual(o.crop["w"], 0.2)

    def test_overrides(self):
        img, _ = spread()
        frame, _ = on_pad(img, frame=(1900, 2600))
        self.assertEqual(len(self._run(frame, 3, split="one", dewarp=False)), 1)
        # reprocess removes the old pages of that capture
        pages = self._run(frame, 3, split="two", dewarp=False, rotate={"1": 180})
        self.assertEqual(len(pages), 2)
        left = [f for f in os.listdir(os.path.join(self.tmp, "pages")) if f.startswith("page_0003_")]
        self.assertEqual(len(left), 8)  # jpg, thumb, ocr, meta x 2


@unittest.skipUnless(os.path.isdir(REAL_DIR), "no real IRIScan photos in scripts/test_pages/scan")
class TestRealPhotos(unittest.TestCase):
    def _each(self, *patterns):
        """Crops of every photo matching any pattern; skip only if there are none."""
        files = sorted(f for p in patterns for f in glob.glob(os.path.join(REAL_DIR, p)))
        if not files:
            self.skipTest(f"no {' / '.join(patterns)}")
        for f in files:
            img = cv2.imread(f)
            (x0, y0, x1, y1), _ = find_book_region(img)
            yield f, img[y0:y1, x0:x1]

    def test_covers_and_loose_pages_not_split(self):
        for f, crop in self._each("cover*.jpg", "loose*.jpg", "tab*.jpg"):
            self.assertFalse(detect_spine(crop).spread, f)

    def test_spreads_split(self):
        for f, crop in self._each("spread_flat*.jpg", "spread_curved*.jpg", "fingers*.jpg"):
            sp = detect_spine(crop)
            self.assertTrue(sp.spread, f"{f}: {sp.reason}")
            x = np.polyval(sp.spine, crop.shape[0] / 2)
            self.assertTrue(0.3 * crop.shape[1] < x < 0.7 * crop.shape[1], f)

    def test_fingers_removed(self):
        for f, crop in self._each("fingers*.jpg"):
            for half in split_spread(crop, detect_spine(crop).spine):
                out, _ = remove_fingers(half, os.path.basename(f))
                m = skin_mask(white_balance(out)) > 0
                b = int(0.05 * min(m.shape))
                border = np.zeros_like(m)
                border[:b], border[-b:], border[:, :b], border[:, -b:] = True, True, True, True
                self.assertLess(float(m[border].mean()), 0.002, f)

    def test_tab_untouched(self):
        for f, crop in self._each("tab*.jpg"):
            out, _ = remove_fingers(crop, os.path.basename(f))
            g0 = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            dark = g0 < 120  # the tab and the print
            self.assertGreater(float((out[dark] == crop[dark]).all(axis=1).mean()), 0.995, f)


if __name__ == "__main__":
    unittest.main()
