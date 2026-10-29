# PyInstaller spec for the Straight Up engine (onedir).
#   cd desktop && pyinstaller engine.spec --noconfirm
# Output: desktop/dist/engine/engine.exe (+ _internal/)
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

import sys
SCRIPTS = os.path.abspath(os.path.join(SPECPATH, '..', 'scripts'))
sys.path.insert(0, SCRIPTS)  # collect_submodules imports the packages

# engine.py runs these by name (runpy), so PyInstaller can't see them: list them
hidden = [
    'fullfix_pdf', 'clean_pdf', 'straighten_pdf', 'replace_ocr', 'inpaint',
    'scan_worker', 'scan_export', 'pdf_out', 'page_audit',
] + collect_submodules('scanner') + collect_submodules('ocr')

a = Analysis(
    [os.path.join(SCRIPTS, 'engine.py')],
    pathex=[SCRIPTS],
    # pymupdf >= 2.0 reads model files from its package folder at import
    datas=collect_data_files('pymupdf'),
    hiddenimports=hidden + ['scipy.ndimage', 'scipy.interpolate', 'scipy.signal'],
    excludes=['tkinter', 'matplotlib', 'IPython', 'pytest', 'PyQt5', 'PySide6'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='engine',
    console=True,       # stdin/stdout carry the scan worker protocol; spawned with windowsHide
    upx=False,          # UPX-packed DLLs trip antivirus more often
)
coll = COLLECT(exe, a.binaries, a.datas, name='engine', upx=False)
