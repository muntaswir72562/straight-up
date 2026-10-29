# Straight Up for Windows

The desktop app is the normal Straight Up web app (all four tabs, including
**Scan Book** for the IRIScan Desk camera), packaged so the team installs one
file, `StraightUp-Setup.exe`, and needs nothing else: no Python, Node or Tesseract.

## What's inside

| Part | Where it comes from | Where it is installed |
|---|---|---|
| Electron shell (`main.js`) | this folder | `%LOCALAPPDATA%\Programs\Straight Up\` |
| Next.js server | `next build` standalone output (`scripts/prepare-server.js`) | `…\resources\server` |
| Python engine | `scripts/engine.py` built with PyInstaller, onedir (`engine.spec`) | `…\resources\engine\engine.exe` |
| Tesseract 5.4 + `tessdata_best` eng/fra | UB Mannheim build (`scripts/fetch-tesseract.ps1`) | `…\resources\tesseract` |

On start the shell runs the server with Electron's own Node on a free
`127.0.0.1` port, with `STRAIGHTUP_ENGINE`, `TESSERACT_CMD`, `TESSDATA_PREFIX`,
`SCAN_DATA_DIR` and `OMP_THREAD_LIMIT=1` set, waits until it answers, then
opens the window. A splash screen shows meanwhile. Camera access is granted to
the app's own page only. Closing the window kills the server and every engine
process.

**User data** (`%APPDATA%\Straight Up\`):

- `scans\`: Scan Book sessions (raw photos, finished pages, exports). Uninstalling **keeps** this folder.
- `logs\`: the last 10 start-up logs (server + Python output). *File → Open logs folder* opens it.

## Getting the installer

Every push to `scan-book-application`, every `desktop-v*` tag, and a manual
run (*Actions → Desktop app (Windows installer) → Run workflow*) builds it.

1. Open the repository on GitHub → **Actions** → **Desktop app (Windows installer)**.
2. Click the latest green run.
3. Under **Artifacts**, download **StraightUp-Setup** (a zip with `StraightUp-Setup.exe`).

For a tag like `desktop-v0.1.0`, the installer is also attached to the
matching GitHub Release.

### First install: Windows SmartScreen

The installer isn't code-signed yet, so the first time Windows shows
*"Windows protected your PC"*. Click **More info → Run anyway**. It installs
for the current user only (no admin rights) and adds desktop and Start-menu
shortcuts.

## Building locally

From the repo root, on Windows with Node 20+ and Python 3.11:

```powershell
npm ci
npx next build
node desktop/scripts/prepare-server.js

pip install -r desktop/engine-requirements.txt
cd desktop
pyinstaller engine.spec --noconfirm --distpath resources --workpath ../build/pyi
powershell -ExecutionPolicy Bypass -File scripts/fetch-tesseract.ps1   # unpacks the UB Mannheim installer with 7-Zip

npm ci
npm start                 # run the app from this folder (uses desktop/resources)
npm run dist              # -> dist/StraightUp-Setup.exe
python smoke/smoke_test.py resources/engine/engine.exe --tesseract resources/tesseract/tesseract.exe
```

Notes:

- electron-builder never copies `node_modules` from `extraResources`, so
  `scripts/after-pack.js` copies the server's `node_modules` in after packing.
- With npm 11+, install scripts are blocked by default. If `node_modules/electron/dist`
  is missing after `npm ci`, run `node node_modules/electron/install.js`.
- The web app is unchanged for Railway: without `STRAIGHTUP_ENGINE`,
  `lib/server/python.ts` runs `python scripts/<script>.py` as before.

## Adding code signing later

1. Get a code-signing certificate (an OV certificate works; an EV certificate
   or Azure Trusted Signing gets SmartScreen reputation immediately).
2. **Certificate file (.pfx):** add the repository secrets `WIN_CSC_LINK`
   (the .pfx, base64) and `WIN_CSC_KEY_PASSWORD`. Then, in
   `.github/workflows/desktop.yml`, replace `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` with:
   ```yaml
   WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
   WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
   ```
   electron-builder then signs the app, the engine and the installer.
3. **Azure Trusted Signing** (no .pfx): add `"azureSignOptions"` under
   `build.win` in `package.json` (endpoint, account and certificate profile
   names), and give the workflow the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
   `AZURE_CLIENT_SECRET` secrets. See the electron-builder "Code Signing → Windows" docs.
