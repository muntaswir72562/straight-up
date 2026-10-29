#!/usr/bin/env python3
"""
Smoke test for the built engine (PyInstaller onedir): runs every subcommand
from the built folder with Python removed from PATH, so it proves the exe
needs no Python install.

  python desktop/smoke/smoke_test.py <path/to/engine.exe> [--tesseract <tesseract.exe>]

Inputs (a small text PDF, a camera-like photo) are made here with
pymupdf/OpenCV from the build machine's Python; the engine itself only uses
what it bundles.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import fitz
import numpy as np

TEXT = ("The Copyright, Designs and Patents Act 1988 makes provision in respect of copyright "
        "and related rights. Section {n} applies where a work is made by an employee. ")


def make_pdf(path, pages=2):
    doc = fitz.open()
    for n in range(1, pages + 1):
        p = doc.new_page(width=420, height=600)
        p.insert_textbox(fitz.Rect(40, 40, 380, 560), TEXT.format(n=n) * 10, fontsize=10)
    # rasterise it like a scan
    out = fitz.open()
    for p in doc:
        pix = p.get_pixmap(dpi=150)
        np_ = out.new_page(width=p.rect.width, height=p.rect.height)
        np_.insert_image(np_.rect, stream=pix.tobytes("jpeg"))
    out.save(path)


def page_image(n, w=420, h=600):
    d = fitz.open()
    p = d.new_page(width=w, height=h)
    p.insert_textbox(fitz.Rect(40, 40, w - 40, h - 40), TEXT.format(n=n) * 10, fontsize=10)
    pix = p.get_pixmap(dpi=150)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3][:, :, ::-1].copy()


def make_spread_photo(path):
    img = np.hstack([page_image(1), page_image(2)]).astype(np.float32)
    w = img.shape[1]
    xs = np.arange(w, dtype=np.float32)
    img *= (1 - 0.3 * np.exp(-((xs - w / 2) / (0.025 * w)) ** 2))[None, :, None]
    H, W = int(img.shape[0] * 1.25), int(img.shape[1] * 1.2)
    frame = np.full((H, W, 3), 26, np.float32)
    y, x = (H - img.shape[0]) // 2, (W - img.shape[1]) // 2
    frame[y:y + img.shape[0], x:x + img.shape[1]] = img
    cv2.imwrite(path, np.clip(frame, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])


def no_python_env(tesseract):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('PYTHON')}
    parts = env.get('PATH', '').split(os.pathsep)
    env['PATH'] = os.pathsep.join(p for p in parts if not os.path.isfile(os.path.join(p, 'python.exe'))
                                  and not os.path.isfile(os.path.join(p, 'python3')))
    env['OMP_THREAD_LIMIT'] = '1'
    if tesseract:
        env['TESSERACT_CMD'] = tesseract
        env['TESSDATA_PREFIX'] = os.path.join(os.path.dirname(tesseract), 'tessdata')
    return env


class Fail(Exception):
    pass


def annotate(title, text):
    """GitHub Actions annotation (readable without access to the job log)."""
    if os.environ.get('GITHUB_ACTIONS'):
        body = text[-3500:].replace('%', '%25').replace('\r', '').replace('\n', '%0A')
        print(f'::error title={title}::{body}')


def run(engine, args, env, **kw):
    r = subprocess.run([engine] + args, env=env, capture_output=True, text=True, timeout=900, **kw)
    if r.returncode != 0:
        print(r.stderr[-4000:])
        annotate(f'engine {args[0]} exited {r.returncode}', r.stderr)
        raise Fail(f"engine {args[0]} exited {r.returncode}")
    return r


def check_progress(path):
    with open(path) as f:
        p = json.load(f)
    if p.get('phase') not in ('done', None):
        raise SystemExit(f"FAIL: progress {p}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('engine')
    ap.add_argument('--tesseract')
    a = ap.parse_args()
    engine = os.path.abspath(a.engine)
    env = no_python_env(a.tesseract)
    tmp = tempfile.mkdtemp(prefix='engine_smoke_')
    try:
        pdf = os.path.join(tmp, 'in.pdf')
        make_pdf(pdf)

        failures = []

        def check(name, fn):
            try:
                fn()
            except Exception as e:  # noqa: BLE001 - report every failing subcommand
                failures.append(name)
                print(f'FAIL {name}: {e!r}')
                if not isinstance(e, Fail):
                    import traceback
                    annotate(f'smoke {name}', traceback.format_exc())

        def usage():
            r = subprocess.run([engine, 'nope'], env=env, capture_output=True, text=True)
            assert r.returncode == 2, f'exit {r.returncode}: {r.stderr[-2000:]}'
            print('ok  usage')

        def fullfix():
            # OCR on: multiprocessing pool inside the frozen exe
            d = os.path.join(tmp, 'fullfix'); os.makedirs(d)
            run(engine, ['fullfix', pdf, os.path.join(d, 'out.pdf'), os.path.join(d, 'p.json'), 'smoke',
                         '1', '1', '0', '1', '', '1'], env)
            check_progress(os.path.join(d, 'p.json'))
            with open(os.path.join(d, 'ocr_results.json'), encoding='utf-8') as f:
                ocr = json.load(f)
            words = sum(len(l.get('words', [])) for pg in ocr for b in pg.get('blocks', []) for l in b.get('lines', []))
            assert len(ocr) == 2 and words > 50, (len(ocr), words)
            assert 'Copyright' in fitz.open(os.path.join(d, 'out.pdf'))[0].get_text()
            print(f'ok  fullfix (OCR {words} words, searchable)')

        def simple(cmd):
            def go():
                d = os.path.join(tmp, cmd); os.makedirs(d)
                run(engine, [cmd, pdf, os.path.join(d, 'out.pdf'), os.path.join(d, 'p.json'), 'smoke'], env)
                assert len(fitz.open(os.path.join(d, 'out.pdf'))) == 2
                print(f'ok  {cmd}')
            return go

        def replace_ocr():
            d = os.path.join(tmp, 'replace'); os.makedirs(d)
            run(engine, ['replace-ocr', pdf, os.path.join(d, 'out.pdf'), os.path.join(d, 'p.json'), '1'], env)
            assert os.path.isfile(os.path.join(d, 'out.pdf'))
            print('ok  replace-ocr')

        def inpaint():
            d = os.path.join(tmp, 'inpaint'); os.makedirs(d)
            img = page_image(1)
            mask = np.zeros(img.shape[:2], np.uint8); mask[100:140, 100:200] = 255
            cv2.imwrite(os.path.join(d, 'i.png'), img); cv2.imwrite(os.path.join(d, 'm.png'), mask)
            run(engine, ['inpaint', os.path.join(d, 'i.png'), os.path.join(d, 'm.png'), os.path.join(d, 'o.png'), '5'], env)
            assert cv2.imread(os.path.join(d, 'o.png')) is not None
            print('ok  inpaint')

        sd = os.path.join(tmp, 'session')

        def scan():
            # scan worker: JSON lines over stdin/stdout, then export
            os.makedirs(os.path.join(sd, 'raw'))
            make_spread_photo(os.path.join(sd, 'raw', 'capture_0001.jpg'))
            jobs = (json.dumps({'id': 'p', 'type': 'ping'}) + '\n'
                    + json.dumps({'id': 'j', 'type': 'process', 'session_dir': sd, 'capture': 1,
                                  'options': {'color_mode': 'clean'}}) + '\n')
            r = run(engine, ['scan-worker'], env, input=jobs)
            events = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
            assert events and events[0] == {'event': 'ready'}, (events[:1], r.stderr[-2000:])
            done = [e for e in events if e.get('id') == 'j' and e['event'] == 'done']
            assert done and len(done[0]['pages']) == 2, (events[-1], r.stderr[-2000:])
            assert all(p['ocr_words'] > 20 for p in done[0]['pages'])
            print(f"ok  scan-worker (spread split into {len(done[0]['pages'])} pages)")

            with open(os.path.join(sd, 'session.json'), 'w') as f:
                json.dump({'bookName': 'smoke', 'order': [p['id'] for p in done[0]['pages']]}, f)
            ed = os.path.join(sd, 'export'); os.makedirs(ed)
            run(engine, ['scan-export', sd, os.path.join(ed, 'out.pdf'), os.path.join(ed, 'p.json'), '1', '1'], env)
            check_progress(os.path.join(ed, 'p.json'))
            out = fitz.open(os.path.join(ed, 'out.pdf'))
            assert len(out) == 2 and 'Copyright' in out[0].get_text()
            assert os.path.isfile(os.path.join(ed, 'ocr_text.txt'))
            print('ok  scan-export (searchable PDF + txt)')

        for name, fn in [('usage', usage), ('fullfix', fullfix), ('clean', simple('clean')),
                         ('straighten', simple('straighten')), ('replace-ocr', replace_ocr),
                         ('inpaint', inpaint), ('scan-worker + scan-export', scan)]:
            check(name, fn)
        if failures:
            raise SystemExit(f"FAILED: {', '.join(failures)}")
        print('ALL OK')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
