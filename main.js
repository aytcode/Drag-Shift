// Drag + Shift: a background add-on for Windows. While dragging a file
// anywhere, press Shift and a radial menu appears under the cursor. Drop the
// file on an action; the result is saved next to the original file.
// No windows of its own: it starts with Windows and lives in the tray.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, Notification, shell, nativeTheme, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');

// Input is read by polling key state straight from Windows: global hooks are
// unreliable here (Explorer's drag loop fakes a mouse-up, packaged builds
// fail to register the hook).
const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('void * __stdcall GetAncestor(void *h, uint flags)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint16_t *buf, int max)');
const VK = { LBUTTON: 0x01, SHIFT: 0x10, ESCAPE: 0x1B };
const isDown = vk => (GetAsyncKeyState(vk) & 0x8000) !== 0;
const leftHeld = () => isDown(VK.LBUTTON);

// Only drags that start in Explorer or on the desktop count, so Shift keeps its
// normal meaning everywhere else (selecting text, moving windows, …).
const FILE_WINDOWS = new Set(['CabinetWClass', 'ExploreWClass', 'Progman', 'WorkerW']);
function classUnderCursor() {
  const p = {};
  if (!GetCursorPos(p)) return '';
  const top = GetAncestor(WindowFromPoint(p), 2 /* GA_ROOT */);
  const buf = new Uint16Array(128);
  const n = GetClassNameW(top, buf, buf.length);
  return String.fromCharCode(...buf.subarray(0, n));
}

const WHEEL = 460; // wheel is 372px; the margin leaves room for its shadow
let wheelWin, tray;
let shown = false;

const log = (...a) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {}
};
process.on('uncaughtException', e => log('ERROR', e.stack));
process.on('unhandledRejection', e => log('ERROR', e?.stack || e));

// Started by Windows at login → stay silent; started by the user → say hello.
const AT_LOGIN = process.argv.includes('--hidden');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
log('starting', AT_LOGIN ? '(login)' : '(manual)');
app.on('second-instance', () => showHelp());

function createWheel() {
  wheelWin = new BrowserWindow({
    width: WHEEL, height: WHEEL, show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  wheelWin.setAlwaysOnTop(true, 'screen-saver');
  // match the Windows theme and accent colour so the wheel looks like part of the system
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  wheelWin.loadFile('index.html', { query: { mode: 'wheel', theme, lang: settings.lang, accent: systemPreferences.getAccentColor() } });
  wheelWin.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) log('wheel', msg); });
}

// ---------- settings (interface language)
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { lang: 'tr' };
function loadSettings() { try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'))); } catch {} }
function setLang(lang) {
  settings.lang = lang;
  fs.writeFileSync(SETTINGS(), JSON.stringify(settings));
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  wheelWin.loadFile('index.html', { query: { mode: 'wheel', theme, lang, accent: systemPreferences.getAccentColor() } });
  buildTray();
}

function showWheel() {
  const p = screen.getCursorScreenPoint();
  wheelWin.setBounds({ x: Math.round(p.x - WHEEL / 2), y: Math.round(p.y - WHEEL / 2), width: WHEEL, height: WHEEL });
  wheelWin.webContents.send('wheel:show');
  wheelWin.showInactive();
  wheelWin.moveTop(); // above any open tool window, so the drop always lands on the wheel
  shown = true;
  // hide once the button is really released (the drop is handled by the wheel window first)
  const poll = setInterval(() => {
    if (!shown) return clearInterval(poll);
    if (!leftHeld()) { clearInterval(poll); setTimeout(hideWheel, 500); }
  }, 80);
}

function hideWheel() {
  if (!shown) return;
  shown = false;
  wheelWin.webContents.send('wheel:hide');
  setTimeout(() => { if (!shown) wheelWin.hide(); }, 200);
}

function startWatching() {
  let mouse = false, shift = false, esc = false, downAt = null, dragging = false;
  setInterval(() => {
    const m = leftHeld(), s = isDown(VK.SHIFT), e = isDown(VK.ESCAPE);
    if (m && !mouse) {
      const cls = classUnderCursor();
      downAt = FILE_WINDOWS.has(cls) ? screen.getCursorScreenPoint() : null; // ignore drags in other apps
      dragging = false;
    }
    const wasDragging = dragging;
    if (m && !dragging && downAt) {
      const p = screen.getCursorScreenPoint();
      if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 8) { dragging = true; log('drag start, shift=' + s); }
    }
    if (!m) dragging = false;
    // Open when Shift is pressed during a drag, or a drag starts with Shift already held;
    // another Shift press while open switches the wheel.
    if (m && dragging && s && !shown && (!shift || !wasDragging)) { log('open wheel'); showWheel(); }
    else if (s && !shift && shown) wheelWin.webContents.send('wheel:cycle');
    if (e && !esc) hideWheel();
    mouse = m; shift = s; esc = e;
  }, 30);
  log('watching input');
}

// One tool window at a time: a new drop replaces the previous editor instead of
// opening behind it. Sized from the screen so the image is large enough to work on.
let editorWin;
function openEditor(file, tool) {
  if (editorWin && !editorWin.isDestroyed()) editorWin.destroy();
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.round(Math.min(Math.max(wa.width * .8, 900), 1500, wa.width));
  const height = Math.round(Math.min(Math.max(wa.height * .88, 640), 1050, wa.height));
  editorWin = new BrowserWindow({
    x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height,
    frame: false, transparent: true, resizable: true, title: 'Drag + Shift',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  editorWin.loadFile('index.html', { query: { mode: 'editor', file, tool, lang: settings.lang } });
}

let helpWin;
function showHelp() {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.show(); helpWin.focus(); return; }
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  helpWin = new BrowserWindow({
    width: 440, height: 420, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    title: 'Drag + Shift', webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  helpWin.loadFile('index.html', { query: { mode: 'help', theme, lang: settings.lang } });
}

function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

ipcMain.handle('save', (_e, dir, name, bytes) => {
  if (!dir || !fs.existsSync(dir)) dir = app.getPath('downloads');
  const p = uniquePath(dir, name.replace(/[<>:"/\\|?*]/g, '_'));
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});
ipcMain.handle('read', (_e, p) => new Uint8Array(fs.readFileSync(p)));
ipcMain.on('editor', (_e, file, tool) => { log('editor', tool, file); openEditor(file, tool); });
ipcMain.on('hide', hideWheel);
ipcMain.on('close', e => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('notify', (_e, title, file) => {
  const n = new Notification({ title: 'Drag + Shift', body: title + (file ? '\n' + file : '') });
  if (file) n.on('click', () => shell.showItemInFolder(file));
  n.show();
});

function trayIcon() {
  // 16x16 orange dot, built in code so the app needs no image files
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), a = Math.max(0, Math.min(1, 7.5 - d)) * 255, i = (y * s + x) * 4;
    buf[i] = 0x20; buf[i + 1] = 0x53; buf[i + 2] = 0xee; buf[i + 3] = a; // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}

function buildTray() {
  const tr = settings.lang === 'tr';
  tray.setToolTip(tr ? 'Drag + Shift — dosya sürüklerken Shift\'e bas' : 'Drag + Shift — press Shift while dragging a file');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr ? 'Drag + Shift açık' : 'Drag + Shift is running', enabled: false },
    { label: tr ? 'Nasıl kullanılır?' : 'How to use', click: showHelp },
    { label: tr ? 'Dil' : 'Language', submenu: [
      { label: 'Türkçe', type: 'radio', checked: tr, click: () => setLang('tr') },
      { label: 'English', type: 'radio', checked: !tr, click: () => setLang('en') },
    ] },
    { label: tr ? 'Windows ile başlat' : 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: tr ? 'Kapat' : 'Quit', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  app.setAppUserModelId('app.dragshift');
  // Start with Windows by default (silently, via --hidden); the tray menu can turn it off.
  const firstRun = path.join(app.getPath('userData'), '.installed');
  if (app.isPackaged && (!fs.existsSync(firstRun) || app.getLoginItemSettings().openAtLogin)) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    fs.writeFileSync(firstRun, '');
  }
  loadSettings();
  createWheel();
  startWatching();
  if (process.env.DS_PREVIEW) wheelWin.webContents.once('did-finish-load', () => {
    // dev only: park the wheel mid-screen to check how it looks
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    wheelWin.setBounds({ x: x + (width - WHEEL) / 2, y: y + (height - WHEEL) / 2, width: WHEEL, height: WHEEL });
    wheelWin.showInactive();
    wheelWin.webContents.executeJavaScript(`openWheel(innerWidth/2, innerHeight/2, 'image'); setHover('crop')`);
  });
  tray = new Tray(trayIcon());
  buildTray();
  tray.on('click', showHelp);
  if (!AT_LOGIN && !process.env.DS_PREVIEW) showHelp();
});

app.on('window-all-closed', () => { /* keep running in the background */ });
