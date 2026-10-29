#!/usr/bin/env python3
"""
One entry point for every Python pipeline, so the desktop app can ship a
single PyInstaller build (engine.exe) instead of a Python install.

  engine fullfix <args...>       = python fullfix_pdf.py <args...>
  engine clean <args...>         = python clean_pdf.py <args...>
  engine straighten <args...>    = python straighten_pdf.py <args...>
  engine replace-ocr <args...>   = python replace_ocr.py <args...>
  engine inpaint <args...>       = python inpaint.py <args...>
  engine scan-worker             = python scan_worker.py
  engine scan-export <args...>   = python scan_export.py <args...>

Each subcommand runs that script's own `__main__` code with the same
arguments (runpy), so behaviour is identical to running the script.
"""
import multiprocessing
import os
import runpy
import sys

COMMANDS = {
    'fullfix': 'fullfix_pdf',
    'clean': 'clean_pdf',
    'straighten': 'straighten_pdf',
    'replace-ocr': 'replace_ocr',
    'inpaint': 'inpaint',
    'scan-worker': 'scan_worker',
    'scan-export': 'scan_export',
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__, file=sys.stderr)
        print(f"Unknown or missing command. Choose one of: {', '.join(COMMANDS)}", file=sys.stderr)
        sys.exit(2)
    module = COMMANDS[sys.argv[1]]
    if not getattr(sys, 'frozen', False):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.argv = [f'{module}.py'] + sys.argv[2:]
    # run_name='__main__' runs the script's entry block; the module keeps its
    # import name in __spec__, so multiprocessing (spawn) workers re-import it
    # by name in the child process.
    runpy.run_module(module, run_name='__main__', alter_sys=True)


if __name__ == '__main__':
    # Must come first: in the frozen exe, multiprocessing children start
    # engine.exe again with --multiprocessing-fork and are handled here.
    multiprocessing.freeze_support()
    main()
