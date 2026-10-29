// Global input state, read by polling (no hooks, no keystroke logging): is the primary mouse
// button down, which modifier is held, is Escape down, and did the drag start in a file manager.
// One small backend per platform, all through koffi.
const koffi = require('koffi');

// Shift alone opens the wheel; Ctrl/Alt (Command/Option) keep their usual meaning in the file manager.
const shiftOnly = (shift, ctrl, alt) => shift && !ctrl && !alt;

function windows() {
  const user32 = koffi.load('user32.dll');
  const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
  const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(POINT p)');
  const GetAncestor = user32.func('void * __stdcall GetAncestor(void *h, uint flags)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint16_t *buf, int max)');
  const down = vk => (GetAsyncKeyState(vk) & 0x8000) !== 0;
  // Explorer windows and the desktop: Shift keeps its usual meaning everywhere else
  const FILE_WINDOWS = new Set(['CabinetWClass', 'ExploreWClass', 'Progman', 'WorkerW']);
  return {
    name: 'win32',
    mouseDown: () => down(0x01),
    shift: () => shiftOnly(down(0x10), down(0x11), down(0x12)),
    escape: () => down(0x1B),
    fromFileManager() {
      const p = {};
      if (!GetCursorPos(p)) return false;
      const buf = new Uint16Array(128);
      const n = GetClassNameW(GetAncestor(WindowFromPoint(p), 2 /* GA_ROOT */), buf, buf.length);
      return FILE_WINDOWS.has(String.fromCharCode(...buf.subarray(0, n)));
    },
  };
}

function mac() {
  // CGEventSource*State answers "what is the hardware doing now" without needing a hook.
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const HID = 1; // kCGEventSourceStateHIDSystemState
  const ButtonState = cg.func('bool CGEventSourceButtonState(int32_t state, uint32_t button)');
  const FlagsState = cg.func('uint64_t CGEventSourceFlagsState(int32_t state)');
  const KeyState = cg.func('bool CGEventSourceKeyState(int32_t state, uint16_t key)');
  const SHIFT = 1n << 17n, CONTROL = 1n << 18n, OPTION = 1n << 19n, COMMAND = 1n << 20n;
  return {
    name: 'darwin',
    mouseDown: () => ButtonState(HID, 0),
    shift() {
      const f = BigInt(FlagsState(HID));
      return shiftOnly(!!(f & SHIFT), !!(f & (CONTROL | COMMAND)), !!(f & OPTION));
    },
    escape: () => KeyState(HID, 53),
    fromFileManager: () => true, // no reliable window class; the wheel still only shows for file drags
  };
}

function linux() {
  // X11 (and XWayland). On a pure Wayland session other apps' input is not visible to us.
  const x = koffi.load('libX11.so.6');
  const XOpenDisplay = x.func('void *XOpenDisplay(const char *name)');
  const XDefaultRootWindow = x.func('unsigned long XDefaultRootWindow(void *dpy)');
  const XQueryPointer = x.func('int XQueryPointer(void *dpy, unsigned long w, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rx, _Out_ int *ry, _Out_ int *wx, _Out_ int *wy, _Out_ unsigned int *mask)');
  const XQueryKeymap = x.func('int XQueryKeymap(void *dpy, _Out_ uint8_t *keys)');
  const XKeysymToKeycode = x.func('uint8_t XKeysymToKeycode(void *dpy, unsigned long keysym)');
  const dpy = XOpenDisplay(null);
  if (!dpy) throw new Error('no X display');
  const root = XDefaultRootWindow(dpy), escCode = XKeysymToKeycode(dpy, 0xff1b);
  const out = { r: [0], c: [0], i: [0], m: [0] };
  const mask = () => { XQueryPointer(dpy, root, out.r, out.c, out.i, out.i, out.i, out.i, out.m); return out.m[0]; };
  const keys = new Uint8Array(32);
  return {
    name: 'linux',
    mouseDown: () => (mask() & 0x100) !== 0, // Button1Mask
    shift() { const m = mask(); return shiftOnly(!!(m & 1), !!(m & 4), !!(m & 8)); }, // Shift, Control, Mod1 (Alt)
    escape() { XQueryKeymap(dpy, keys); return !!(keys[escCode >> 3] & (1 << (escCode & 7))); },
    fromFileManager: () => true,
  };
}

const none = reason => ({ name: 'none', reason, mouseDown: () => false, shift: () => false, escape: () => false, fromFileManager: () => false });

module.exports = function createInput() {
  try {
    if (process.platform === 'win32') return windows();
    if (process.platform === 'darwin') return mac();
    if (process.platform === 'linux') return linux();
    return none('unsupported platform');
  } catch (e) {
    return none(e.message); // the Home window still works; only the global drag wheel is off
  }
};
