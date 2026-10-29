// Straight Up desktop shell.
//
// Starts the Next.js standalone server with Electron's own Node
// (ELECTRON_RUN_AS_NODE) on a free localhost port, with the bundled Python
// engine and Tesseract, then opens a window on it. Everything the server and
// the Python worker print goes to userData/logs.
'use strict';

const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const START_TIMEOUT_MS = 120_000; // first start after install: antivirus scans every file
const KEEP_LOGS = 10;

let mainWindow = null;
let splash = null;
let server = null;
let serverUrl = null;
let quitting = false;
let logStream = null;

// ── Paths ─────────────────────────────────────────────────────────────

/** Bundled resources: <install>/resources/* when packaged, desktop/resources/* in dev. */
function resource(...p) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, 'resources', ...p);
}

const logsDir = () => path.join(app.getPath('userData'), 'logs');
const scansDir = () => path.join(app.getPath('userData'), 'scans');

// ── Logging ───────────────────────────────────────────────────────────

function openLog() {
  fs.mkdirSync(logsDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  logStream = fs.createWriteStream(path.join(logsDir(), `straightup-${stamp}.log`), { flags: 'a' });
  // keep the last few logs only
  const old = fs.readdirSync(logsDir()).filter((f) => f.startsWith('straightup-')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_LOGS))) {
    try { fs.unlinkSync(path.join(logsDir(), f)); } catch { /* in use */ }
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] [main] ${parts.join(' ')}\n`;
  logStream?.write(line);
  if (!app.isPackaged) process.stdout.write(line);
}

// ── Server ────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const dir = resource('server');
  const engine = resource('engine', 'engine.exe');
  const tesseract = resource('tesseract', 'tesseract.exe');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    STRAIGHTUP_ENGINE: engine,
    TESSERACT_CMD: tesseract,
    TESSDATA_PREFIX: resource('tesseract', 'tessdata'),
    SCAN_DATA_DIR: scansDir(),
    OMP_THREAD_LIMIT: '1',
  };
  for (const [name, p] of [['server', path.join(dir, 'server.js')], ['engine', engine], ['tesseract', tesseract]]) {
    if (!fs.existsSync(p)) log(`WARNING: ${name} missing at ${p}`);
  }
  fs.mkdirSync(scansDir(), { recursive: true });
  log(`starting server on port ${port}`);
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // server stdout/stderr (includes the Python engine's stderr, which the server forwards)
  child.stdout.on('data', (d) => logStream?.write(d));
  child.stderr.on('data', (d) => logStream?.write(d));
  child.on('exit', (code, signal) => {
    log(`server exited code=${code} signal=${signal}`);
    server = null;
    if (!quitting) {
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'Straight Up',
        message: 'The Straight Up engine stopped unexpectedly.',
        detail: 'Your scans are saved on disk. Restart to continue where you left off.',
        buttons: ['Restart', 'Open logs folder', 'Quit'],
        defaultId: 0,
      });
      if (choice === 0) { app.relaunch(); app.exit(0); }
      else if (choice === 1) { shell.openPath(logsDir()); app.exit(1); }
      else app.exit(1);
    }
  });
  return child;
}

function waitForServer(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(3000, () => req.destroy());
    };
    const retry = () => {
      if (!server) return reject(new Error('server exited during start-up'));
      if (Date.now() - started > timeoutMs) return reject(new Error('server did not start in time'));
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

/** Kill the server and everything it started (Python worker, exports). */
function stopServer() {
  if (!server?.pid) return;
  log('stopping server');
  try {
    // /T: whole process tree, so no engine.exe is left running
    execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    try { server.kill(); } catch { /* gone */ }
  }
  server = null;
}

// ── Windows ───────────────────────────────────────────────────────────

function showSplash() {
  splash = new BrowserWindow({
    width: 380, height: 220, frame: false, resizable: false, show: true, center: true,
    backgroundColor: '#f7f6f3', skipTaskbar: false, title: 'Straight Up',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
}

function lockDown(origin) {
  const ses = session.defaultSession;
  // camera for our own page only; nothing else
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    let ok = false;
    try {
      ok = permission === 'media'
        && new URL(details.requestingUrl).origin === origin
        && (details.mediaTypes ?? ['video']).every((t) => t === 'video');
    } catch { ok = false; }
    if (!ok) log(`denied permission ${permission} for ${details.requestingUrl}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => (
    permission === 'media' && requestingOrigin === origin
  ));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366, height: 860, minWidth: 1000, minHeight: 640, show: false,
    title: 'Straight Up', backgroundColor: '#f7f6f3',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = mainWindow.webContents;
  // external links open in the browser; the window never leaves the app
  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) { e.preventDefault(); shell.openExternal(url); }
  });
  mainWindow.once('ready-to-show', () => {
    if (splash) { splash.destroy(); splash = null; }
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(serverUrl);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open scans folder', click: () => shell.openPath(scansDir()) },
        { label: 'Open logs folder', click: () => shell.openPath(logsDir()) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Straight Up',
          click: () => dialog.showMessageBox({
            type: 'info', title: 'Straight Up',
            message: `Straight Up ${app.getVersion()}`,
            detail: `Scans: ${scansDir()}\nLogs: ${logsDir()}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ─────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow ?? splash;
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(async () => {
    openLog();
    log(`Straight Up ${app.getVersion()} (electron ${process.versions.electron}, packaged=${app.isPackaged})`);
    buildMenu();
    showSplash();
    try {
      const port = await freePort();
      serverUrl = `http://127.0.0.1:${port}`;
      lockDown(serverUrl);
      server = startServer(port);
      await waitForServer(`${serverUrl}/`, START_TIMEOUT_MS);
      log(`server ready at ${serverUrl}`);
      createWindow();
    } catch (e) {
      log(`start-up failed: ${e.stack || e}`);
      quitting = true;
      stopServer();
      const choice = dialog.showMessageBoxSync({
        type: 'error', title: 'Straight Up',
        message: 'Straight Up could not start.',
        detail: String(e.message || e),
        buttons: ['Open logs folder', 'Quit'],
      });
      if (choice === 0) await shell.openPath(logsDir());
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopServer(); });
  app.on('will-quit', () => { stopServer(); logStream?.end(); });
}
