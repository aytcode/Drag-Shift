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
const GetAsyncKeyState = koffi.load('user32.dll').func('short __stdcall GetAsyncKeyState(int)');
const VK = { LBUTTON: 0x01, SHIFT: 0x10, ESCAPE: 0x1B };
const isDown = vk => (GetAsyncKeyState(vk) & 0x8000) !== 0;
const leftHeld = () => isDown(VK.LBUTTON);

const WHEEL = 460; // wheel is 372px; the margin leaves room for its shadow
let wheelWin, tray;
let shown = false;

if (!app.requestSingleInstanceLock()) app.quit();

const log = (...a) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {}
};
process.on('uncaughtException', e => log('ERROR', e.stack));
process.on('unhandledRejection', e => log('ERROR', e?.stack || e));

function createWheel() {
  wheelWin = new BrowserWindow({
    width: WHEEL, height: WHEEL, show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  wheelWin.setAlwaysOnTop(true, 'screen-saver');
  // match the Windows theme and accent colour so the wheel looks like part of the system
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  wheelWin.loadFile('index.html', { query: { mode: 'wheel', theme, accent: systemPreferences.getAccentColor() } });
  wheelWin.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) log('wheel', msg); });
}

function showWheel() {
  const p = screen.getCursorScreenPoint();
  wheelWin.setBounds({ x: Math.round(p.x - WHEEL / 2), y: Math.round(p.y - WHEEL / 2), width: WHEEL, height: WHEEL });
  wheelWin.webContents.send('wheel:show');
  wheelWin.showInactive();
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
    if (m && !mouse) { downAt = screen.getCursorScreenPoint(); dragging = false; }
    if (m && !dragging && downAt) {
      const p = screen.getCursorScreenPoint();
      if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 8) dragging = true;
    }
    if (!m) dragging = false;
    // Shift pressed while already dragging (not held before the drag began)
    if (s && !shift && m && dragging) {
      log('shift during drag, shown=' + shown);
      if (!shown) showWheel(); else wheelWin.webContents.send('wheel:cycle');
    }
    if (e && !esc) hideWheel();
    mouse = m; shift = s; esc = e;
  }, 30);
  log('watching input');
}

function openEditor(file, tool) {
  const win = new BrowserWindow({
    width: 620, height: 720, frame: false, transparent: true, resizable: true, alwaysOnTop: true,
    title: 'Drag + Shift', webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html', { query: { mode: 'editor', file, tool } });
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
ipcMain.on('editor', (_e, file, tool) => openEditor(file, tool));
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

app.whenReady().then(() => {
  app.setAppUserModelId('app.dragshift');
  // Start with Windows by default; the tray menu can turn it off.
  const firstRun = path.join(app.getPath('userData'), '.installed');
  if (app.isPackaged && !fs.existsSync(firstRun)) {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(firstRun, '');
  }
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
  tray.setToolTip('Drag + Shift — dosya sürüklerken Shift\'e bas');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Drag + Shift açık', enabled: false },
    { label: 'Windows ile başlat', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Kapat', click: () => app.quit() },
  ]));
});

app.on('window-all-closed', () => { /* keep running in the background */ });
