#!/usr/bin/env python3
"""
Scan Book worker: one long-lived process, so cv2/scipy/Tesseract setup is
paid once rather than per capture.

Reads one JSON job per line on stdin, runs them one at a time in order, and
writes one JSON event per line on stdout:

  in:  {"id": "j1", "type": "process", "session_dir": "...", "capture": 3,
        "options": {"color_mode": "clean", "dewarp": true, ...}}
  in:  {"id": "j2", "type": "ping"}
  out: {"event": "ready"}
  out: {"id": "j1", "event": "progress", "stage": "dewarp (0003_1)"}
  out: {"id": "j1", "event": "done", "pages": [<meta>, ...]}
  out: {"id": "j1", "event": "error", "error": "..."}

A reprocess with an override is the same "process" job with other options:
it always starts again from raw/capture_XXXX.jpg. All logging goes to
stderr; stdout carries only the protocol.
"""
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Libraries that print would corrupt the protocol: keep the real stdout for
# events and send everything else to stderr.
_OUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _OUT.flush()


def run_job(job):
    from scanner.capture import Options, process_capture
    jid = job.get("id")
    kind = job.get("type")
    if kind == "ping":
        emit({"id": jid, "event": "done"})
        return
    if kind != "process":
        raise ValueError(f"unknown job type {kind!r}")
    sdir = job["session_dir"]
    cap = int(job["capture"])
    raw = os.path.join(sdir, "raw", f"capture_{cap:04d}.jpg")
    pages = process_capture(raw, os.path.join(sdir, "pages"), cap, Options.from_dict(job.get("options")),
                            progress=lambda stage: emit({"id": jid, "event": "progress", "stage": stage}))
    emit({"id": jid, "event": "done", "pages": pages})


def main():
    # import the heavy modules up front, so the first capture is fast too
    import scanner.capture  # noqa: F401
    import scanner.scan_page  # noqa: F401
    import ocr  # noqa: F401
    emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            run_job(job)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            emit({"id": job.get("id"), "event": "error", "error": str(e)})


if __name__ == "__main__":
    main()
