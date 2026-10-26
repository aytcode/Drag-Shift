// Drag + Shift: a background add-on for Windows. While dragging a file
// anywhere, press Shift and a radial menu appears under the cursor. Drop the
// file on an action; the result is saved next to the original file.
// No windows of its own: it starts with Windows and lives in the tray.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, nativeTheme, desktopCapturer } = require('electron');
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

const WHEEL = 680; // the wheel (652px with its option arc) plus room for the shadow
let wheelWin, tray;
let shown = false;

const log = (...a) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {}
};
process.on('uncaughtException', e => log('ERROR', e.stack));
process.on('unhandledRejection', e => log('ERROR', e?.stack || e));

// Started by Windows at login → stay silent; started by the user → say hello.
const AT_LOGIN = process.argv.includes('--hidden');
// Everything here is a few small windows with pre-blurred glass, so software rendering is just as
// fast (wheel shows ~25 ms after Shift) and saves ~180 MB plus all GPU use for a tray add-on.
app.disableHardwareAcceleration();
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
  wheelWin.loadFile('index.html', { query: { mode: 'wheel', lang: settings.lang } });
  wheelWin.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) log('wheel', msg); });
}

// ---------- settings (interface language)
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { lang: 'tr' };
function loadSettings() { try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS(), 'utf8'))); } catch {} }
function setLang(lang) {
  settings.lang = lang;
  fs.writeFileSync(SETTINGS(), JSON.stringify(settings));
  wheelWin.loadFile('index.html', { query: { mode: 'wheel', lang } });
  buildTray();
}

// ---------- frosted glass: a small snapshot of the screen taken when a file drag starts.
// It is going to be blurred anyway, so a quarter-resolution JPEG is plenty and costs almost nothing;
// the wheel page blurs it once and reuses it, so pressing Shift never waits on it.
let snap = null, snapping = false;
function captureScreen() {
  if (snapping || (snap && Date.now() - snap.at < 1500)) return;
  snapping = true;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width / 4), height: Math.round(d.size.height / 4) } })
    .then(srcs => {
      const src = srcs.find(x => x.display_id === String(d.id)) || srcs[0];
      snap = { at: Date.now(), bounds: d.bounds, url: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(75).toString('base64') };
      wheelWin.webContents.send('wheel:glass', snap);
    })
    .catch(e => log('capture failed', e.message))
    .finally(() => { snapping = false; });
}

function showWheel() {
  const p = screen.getCursorScreenPoint(), db = screen.getDisplayNearestPoint(p).bounds;
  // keep the whole wheel (and its option arc) on the cursor's screen
  const x = Math.round(Math.min(Math.max(p.x - WHEEL / 2, db.x), db.x + db.width - WHEEL));
  const y = Math.round(Math.min(Math.max(p.y - WHEEL / 2, db.y), db.y + db.height - WHEEL));
  wheelWin.setBounds({ x, y, width: WHEEL, height: WHEEL });
  lastDrop = p;
  const glass = snap && Date.now() - snap.at < 20000 ? snap.at : 0;
  wheelWin.webContents.send('wheel:show', { cx: p.x - x, cy: p.y - y, winX: x, winY: y, glass });
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
  setTimeout(() => { if (!shown) wheelWin.hide(); }, 320); // let the close spring finish
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
    // The screen snapshot for the glass blocks this process for a few hundred ms, so it never runs
    // before the wheel is shown: taken right after the drag starts, unless the wheel is already up
    // (it would photograph itself) — then the wheel simply uses its plain tint.
    if (dragging && !wasDragging && !shown) setTimeout(captureScreen, 0);
    if (e && !esc) hideWheel();
    mouse = m; shift = s; esc = e;
  }, 20);
  log('watching input');
}

// One tool window at a time: a new drop replaces the previous editor instead of
// opening behind it. Sized from the screen so the image is large enough to work on.
let editorWin;
function openEditor(file, tool) {
  if (editorWin && !editorWin.isDestroyed()) editorWin.destroy();
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const small = ['ext', 'hash'].includes(tool); // dialogs without an image preview
  const width = small ? 560 : Math.round(Math.min(Math.max(wa.width * .8, 900), 1500, wa.width));
  const height = small ? 420 : Math.round(Math.min(Math.max(wa.height * .88, 640), 1050, wa.height));
  editorWin = new BrowserWindow({
    x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height,
    frame: false, transparent: true, resizable: true, show: false, title: 'Drag + Shift',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  editorWin.loadFile('index.html', { query: { mode: 'editor', file, tool, lang: settings.lang } });
  // we run in the background, so Windows would open the window behind the active app; lift it once
  const win = editorWin;
  win.once('ready-to-show', () => { win.setAlwaysOnTop(true); win.show(); win.focus(); setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 400); });
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

const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_');
ipcMain.handle('save', (_e, dir, name, bytes) => {
  if (!dir || !fs.existsSync(dir)) dir = app.getPath('downloads');
  // "folder/sub/file" (e.g. an extracted ZIP) → create the folders; '..' can never leave dir
  const parts = name.split(/[\\/]/).filter(s => s && s !== '.' && s !== '..').map(safeName);
  const target = path.join(dir, ...parts.slice(0, -1));
  fs.mkdirSync(target, { recursive: true });
  const p = uniquePath(target, parts[parts.length - 1] || '_');
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});
ipcMain.handle('rename', (_e, src, newName) => {
  const p = uniquePath(path.dirname(src), safeName(path.basename(newName)));
  fs.renameSync(src, p);
  return p;
});
ipcMain.handle('read', (_e, p) => new Uint8Array(fs.readFileSync(p)));
ipcMain.on('editor', (_e, file, tool) => { log('editor', tool, file); openEditor(file, tool); });
ipcMain.on('hide', hideWheel);
ipcMain.on('close', e => BrowserWindow.fromWebContents(e.sender)?.close());
// ---------- progress card (warm glass like the wheel), shown where the file was dropped
let toastWin, toastTimer, lastDrop = null;
function showToast(state) {
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({ width: 400, height: 120, show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.loadFile('index.html', { query: { mode: 'toast', lang: settings.lang } });
    toastWin.webContents.once('did-finish-load', () => showToast(state));
    return;
  }
  const p = lastDrop || screen.getCursorScreenPoint(), wa = screen.getDisplayNearestPoint(p).workArea;
  toastWin.setBounds({ x: Math.round(Math.min(Math.max(p.x - 200, wa.x), wa.x + wa.width - 400)),
    y: Math.round(Math.min(Math.max(p.y - 60, wa.y), wa.y + wa.height - 120)), width: 400, height: 120 });
  toastWin.webContents.send('toast:state', state);
  toastWin.showInactive();
  clearTimeout(toastTimer);
  if (state.state !== 'working') toastTimer = setTimeout(() => toastWin.webContents.send('toast:state', { state: 'hide' }), state.state === 'error' ? 5000 : 3200);
}
ipcMain.on('progress', (_e, state) => showToast(state));
ipcMain.on('notify', (_e, title, file) => showToast({ state: /^(Hata|Error)/.test(title) ? 'error' : 'done', title, file }));
ipcMain.on('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.on('toast-hidden', () => toastWin?.hide());

function trayIcon() {
  // 16x16 blue dot, built in code so the app needs no image files
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), a = Math.max(0, Math.min(1, 7.5 - d)) * 255, i = (y * s + x) * 4;
    buf[i] = 0xff; buf[i + 1] = 0x7a; buf[i + 2] = 0x1f; buf[i + 3] = a; // BGRA
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
    // dev only: open the image wheel mid-screen with CONVERT expanded and JPG under the "cursor"
    captureScreen();
    setTimeout(() => {
      const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
      const wx = x + Math.round((width - WHEEL) / 2), wy = y + Math.round((height - WHEEL) / 2);
      wheelWin.setBounds({ x: wx, y: wy, width: WHEEL, height: WHEEL });
      wheelWin.webContents.send('wheel:show', { cx: WHEEL / 2, cy: WHEEL / 2, winX: wx, winY: wy, glass: snap?.at || 0 });
      wheelWin.showInactive(); shown = true;
      setTimeout(() => wheelWin.webContents.executeJavaScript(`(() => { openWheel(wheel.cx, wheel.cy, "image"); const st = 2 * Math.PI / 9, a = 6 * st;
        updateHover(wheel.cx + 140 * Math.sin(a), wheel.cy - 140 * Math.cos(a)); cycleMode();
        setTimeout(() => { const sa = wheel.sub.a0 + 1.5 * SUB_STEP, r = (RS1 + RS2) / 2; updateHover(wheel.cx + r * Math.sin(sa), wheel.cy - r * Math.cos(sa)); }, 500); })()`), 700);
      if (process.env.DS_PREVIEW === 'toast') { lastDrop = { x: x + width / 2, y: y + height / 2 + 330 }; setTimeout(() => showToast({ state: 'working', title: 'JPG', sub: 'İşleniyor…' }), 300); setTimeout(() => log('toast bounds', JSON.stringify(toastWin.getBounds()), JSON.stringify(toastWin.getContentBounds())), 1500); }
    }, 1200);
  });
  tray = new Tray(trayIcon());
  buildTray();
  tray.on('click', showHelp);
  if (!AT_LOGIN && !process.env.DS_PREVIEW) showHelp();
  if (process.env.DS_EDITOR) openEditor(process.env.DS_EDITOR, process.env.DS_TOOL || 'addbg'); // dev only
});

app.on('window-all-closed', () => { /* keep running in the background */ });
