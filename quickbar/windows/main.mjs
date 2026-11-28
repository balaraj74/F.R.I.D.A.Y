// FRIDAY Quick_Bar_Host for Windows: a tray-only Electron app (no main window) that watches the
// pointer, shows the overlay on a shake or Ctrl+Alt+Space, and renders the Control_Indicator.
// All decisions live in lib/*.mjs (pure, unit-tested); this file only wires Electron to them.
//
// Run: `electron quickbar/windows` (the supervisor does this, hidden) or `npm start` in this folder.
import {execFile, spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import electron from 'electron';
import {GatewayClient, readGatewayConfig} from '../daemon/gateway-client.mjs';
import {tcpUp, httpOk, readHudVoiceRuntime, PORTS} from '../daemon/services.mjs';
import {leadParagraphIfComplete, pickSpoken} from '../daemon/speak-text.mjs';
import {readVoiceSettings} from '../daemon/voice.mjs';
import {ShakeDetector} from '../extension/shake.js';
import {createControlMonitor, createStopRequester} from './lib/control.mjs';
import {createEnsureGateway} from './lib/gateway-up.mjs';
import {fridayPaths} from './lib/paths.mjs';
import {placeOverlay, windowHeight} from './lib/placement.mjs';
import {captureDesktop} from './lib/screenshot.mjs';
import {QuickSession} from './lib/session.mjs';
import {parseOwnConfig, parseSetup, registerFirstFree, resolveSpeechMode, shortcutCandidates} from './lib/settings.mjs';
import {ShakeFeed, startPolling} from './lib/shake-feed.mjs';
import {Speaker} from './lib/speaker.mjs';
import {transcribeWav} from './lib/stt.mjs';
import {createSummonFlow} from './lib/summon-flow.mjs';
import {renderTrayBgra} from './lib/tray-icon.mjs';
import {edgeTtsBinary, synthesize} from './lib/tts.mjs';

const {app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen, session: electronSession} = electron;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..', '..');
const home = os.homedir();
const paths = fridayPaths(home);
const isWindows = process.platform === 'win32';
const STOP_SHORTCUT = 'Control+Alt+Backspace';
const log = (...a) => console.log('[quickbar]', ...a);

// ---- single instance ----
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
// No separate GPU process: it costs about 60 MB while idle, and the overlay is a small 2D canvas.
app.disableHardwareAcceleration();
app.setAppUserModelId('com.friday.quickbar');
app.on('window-all-closed', () => {}); // the host has no main window and must outlive the overlay

// ---- settings (re-read at most every 5 s, so edits apply without a restart) ----
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
let settingsCache = {at: 0, value: null};
function settings() {
  const now = Date.now();
  if (!settingsCache.value || now - settingsCache.at > 5000) {
    const setup = parseSetup(readText(paths.setup));
    const own = parseOwnConfig(readText(paths.quickbar));
    settingsCache = {at: now, value: {setup, own, mode: resolveSpeechMode({setup, own, env: process.env})}};
  }
  return settingsCache.value;
}

// ---- state ----
let paused = false;
let overlay = null; // {win, placement, ready:Promise, markReady, playbackResolve}
let indicatorWin = null;
let tray = null;
let stopPolling = null;
const useMaterial = isWindows && process.env.FRIDAY_QUICKBAR_MATERIAL !== 'none';

// ---- gateway and services ----
const gwCfg = readGatewayConfig();
const gateway = new GatewayClient(gwCfg);
const ensureGateway = createEnsureGateway({
  tcpUp,
  port: gwCfg.port,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  // Ask the Service_Manager (Track 1: scripts/friday-service.mjs) to start proxy and gateway.
  startServices: async () => {
    const script = path.join(repoDir, 'scripts', 'friday-service.mjs');
    if (!fs.existsSync(script)) return;
    const child = spawn(process.execPath, [script, 'start'], {
      env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  },
});
// Keep the gateway link warm between summons, so the first question has no connection delay.
const warmTimer = setInterval(async () => {
  if (!gateway.connected && (await tcpUp(gwCfg.port))) gateway.connect().catch(() => {});
}, 10_000);
warmTimer.unref?.();

// ---- speech ----
const tmpDir = path.join(os.tmpdir(), 'friday-quickbar');
const ttsDeps = {
  execFile,
  fetch,
  readRuntime: () => readHudVoiceRuntime(paths.voiceRuntime),
  readVoiceSettings: () => readVoiceSettings(paths.voiceSettings),
  binary: edgeTtsBinary({platform: process.platform, home, exists: fs.existsSync}),
  tmpFile: (ext) => {
    fs.mkdirSync(tmpDir, {recursive: true, mode: 0o700});
    return path.join(tmpDir, `say-${crypto.randomUUID().slice(0, 8)}.${ext}`);
  },
  readFile: (f) => fs.readFileSync(f),
  rm: (f) => fs.rmSync(f, {force: true}),
};
const speaker = new Speaker({
  synthesize: (text) => synthesize({mode: settings().mode, text, deps: ttsDeps}),
  play: (audio) =>
    new Promise((resolve) => {
      if (!overlay) return resolve(false);
      overlay.playbackResolve?.(false);
      overlay.playbackResolve = resolve;
      overlay.win.webContents.send('qb:play', audio);
    }),
  stopPlayback: () => {
    if (!overlay) return;
    overlay.playbackResolve?.(false);
    overlay.playbackResolve = null;
    overlay.win.webContents.send('qb:stop-playback');
  },
});

const emit = (ev) => {
  if (overlay && !overlay.win.isDestroyed()) overlay.win.webContents.send('qb:event', ev);
};

const session = new QuickSession({
  gateway,
  ensureGateway,
  ensureStt: async () => {
    const base = `http://127.0.0.1:${PORTS.hudStt}`;
    return (await httpOk(`${base}/`)) ? base : null;
  },
  transcribe: transcribeWav,
  speaker,
  emit,
  speech: {pickSpoken, leadParagraphIfComplete},
  speakEnabled: () => settings().mode !== 'none',
});

// ---- overlay window ----
function overlayConfig() {
  return {material: useMaterial, pad: useMaterial ? 0 : 12, radius: useMaterial ? 8 : 26};
}

function displaysNow() {
  return screen.getAllDisplays().map((d) => ({id: d.id, bounds: d.bounds, workArea: d.workArea}));
}

async function prepareOverlay(pointer) {
  const cfg = overlayConfig();
  const placement = placeOverlay({pointer, displays: displaysNow(), primaryId: screen.getPrimaryDisplay().id, pad: cfg.pad});
  const win = new BrowserWindow({
    x: placement.window.x,
    y: placement.window.y,
    width: placement.window.width,
    height: 150,
    show: false,
    paintWhenInitiallyHidden: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    ...(useMaterial ? {backgroundMaterial: 'acrylic'} : {}),
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  let markReady;
  const ready = new Promise((r) => {
    markReady = r;
  });
  const entry = {win, placement, cfg, ready, markReady, playbackResolve: null};
  overlay = entry;
  win.on('closed', () => {
    if (overlay === entry) overlay = null;
    flow.closed();
  });
  try {
    await win.loadFile(path.join(here, 'overlay', 'index.html'));
    await Promise.race([ready, new Promise((r) => setTimeout(r, 5000))]);
  } catch (err) {
    discardOverlay();
    throw err;
  }
  return entry;
}

function discardOverlay() {
  if (overlay && !overlay.win.isDestroyed()) overlay.win.destroy();
  overlay = null;
}

function showOverlay(entry) {
  const {win, placement} = entry;
  win.setBounds({x: placement.window.x, y: placement.window.y, width: placement.window.width, height: win.getBounds().height});
  win.showInactive();
  // Typing goes to the bar first, like on Linux. Windows may refuse to move focus; clicking the card works either way.
  win.focus();
}

const flow = createSummonFlow({
  getPointer: () => screen.getCursorScreenPoint(),
  prepareOverlay,
  capture: () => captureDesktop({desktopCapturer, screen, nativeImage}),
  showOverlay,
  discardOverlay,
  session,
  log,
  notify: (text) => emit({ev: 'status', text}),
});

function fromOverlay(e) {
  return !!overlay && !overlay.win.isDestroyed() && e.sender === overlay.win.webContents;
}

ipcMain.handle('qb:init', (e) => {
  if (!fromOverlay(e)) return null;
  return {...overlay.cfg, answerMax: overlay.placement.answerMax};
});
ipcMain.on('qb:ready', (e) => fromOverlay(e) && overlay.markReady());
ipcMain.on('qb:ask', (e, text) => fromOverlay(e) && typeof text === 'string' && session.ask(text.slice(0, 4000)).catch((err) => emit({ev: 'error', message: String(err?.message ?? err)})));
ipcMain.on('qb:mic', (e, action) => fromOverlay(e) && action === 'start' && session.micStarted());
ipcMain.on('qb:audio', (e, bytes) => {
  if (!fromOverlay(e) || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) return;
  if (bytes.length > 2_000_000) return; // 30 s of 16 kHz mono is about 1 MB
  session.audio(bytes).catch(() => {});
});
ipcMain.on('qb:silence', (e) => fromOverlay(e) && session.silence());
ipcMain.on('qb:close', (e) => {
  if (fromOverlay(e)) overlay.win.close();
});
ipcMain.on('qb:resize', (e, height) => {
  if (!fromOverlay(e) || !Number.isFinite(height) || height <= 0) return;
  const b = overlay.win.getBounds();
  overlay.win.setBounds({...b, height: windowHeight(overlay.placement, height)});
});
ipcMain.on('qb:playback-done', (e, ok) => {
  if (!fromOverlay(e)) return;
  overlay.playbackResolve?.(ok);
  overlay.playbackResolve = null;
});

// ---- microphone permission: audio, for the overlay only ----
function setupPermissions() {
  const ses = electronSession.defaultSession;
  const allowed = (wc, permission) => permission === 'media' && !!overlay && wc === overlay.win.webContents;
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed(wc, permission)));
  ses.setPermissionCheckHandler((wc, permission) => allowed(wc, permission));
}

// ---- Control_Indicator and stop ----
const requestStop = createStopRequester({fs, stopFile: paths.stop});

function showIndicator() {
  if (indicatorWin && !indicatorWin.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const width = 380;
  const height = 44;
  indicatorWin = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 10,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true},
  });
  indicatorWin.setAlwaysOnTop(true, 'screen-saver');
  indicatorWin.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  indicatorWin.loadFile(path.join(here, 'indicator', 'index.html')).then(() => indicatorWin?.showInactive());
  indicatorWin.on('closed', () => {
    indicatorWin = null;
  });
}

function hideIndicator() {
  if (indicatorWin && !indicatorWin.isDestroyed()) indicatorWin.destroy();
  indicatorWin = null;
}

ipcMain.on('ind:stop', (e) => {
  if (indicatorWin && !indicatorWin.isDestroyed() && e.sender === indicatorWin.webContents) requestStop();
});

const control = createControlMonitor({
  read: () => readText(paths.control),
  onChange: (c) => (c.active ? showIndicator() : hideIndicator()),
});

// ---- tray ----
function trayImage(isPaused) {
  return nativeImage.createFromBitmap(renderTrayBgra(32, {paused: isPaused}), {width: 32, height: 32});
}

let traySignature = '';
function refreshTray() {
  if (!tray) return;
  const enabled = settings().setup.quickbarEnabled;
  const signature = `${enabled}:${paused}`;
  if (signature === traySignature) return;
  traySignature = signature;
  tray.setImage(trayImage(paused || !enabled));
  tray.setToolTip(!enabled ? 'FRIDAY Quick Bar (off in setup)' : paused ? 'FRIDAY Quick Bar (shake paused)' : 'FRIDAY Quick Bar');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {label: 'Open quick bar', enabled, click: () => flow.summon('tray')},
      {label: 'Pause shake', type: 'checkbox', checked: paused, enabled, click: (item) => {
        paused = item.checked;
        refreshTray();
      }},
      {type: 'separator'},
      {label: 'Quit (until next logon)', click: () => app.quit()},
    ]),
  );
}

function tell(title, body) {
  log(title, body);
  try {
    if (Notification.isSupported()) new Notification({title, body}).show();
  } catch {
    // no notification service
  }
}

// ---- start ----
app.whenReady().then(() => {
  setupPermissions();
  tray = new Tray(trayImage(false));
  tray.on('click', () => flow.summon('tray'));
  refreshTray();

  const detector = new ShakeDetector();
  const feed = new ShakeFeed({
    screen,
    now: () => performance.now(),
    detector,
    onShake: () => flow.summon('shake'),
    isSuspended: () => paused || flow.isOpen || !settings().setup.quickbarEnabled,
  });
  stopPolling = startPolling(feed);

  const cands = shortcutCandidates(settings().own);
  if (settings().setup.quickbarEnabled) {
    const r = registerFirstFree((a, fn) => globalShortcut.register(a, fn), cands, () => flow.summon('shortcut'));
    if (!r.accelerator) tell('FRIDAY Quick Bar', `Another program owns ${cands[0]}. Shake the mouse instead, or set "shortcut" in ~/.friday/quickbar.json.`);
    else if (!r.preferred) tell('FRIDAY Quick Bar', `${cands[0]} is taken by another program. Use ${r.accelerator} instead.`);
  }
  if (!globalShortcut.register(STOP_SHORTCUT, () => requestStop())) log(`could not register ${STOP_SHORTCUT}`);

  control.check();
  const controlTimer = setInterval(() => control.check(), 500);
  controlTimer.unref?.();
  setInterval(refreshTray, 30_000).unref?.();
});

app.on('second-instance', () => flow.summon('second-instance'));
app.on('will-quit', () => {
  stopPolling?.();
  globalShortcut.unregisterAll();
  speaker.stop();
  gateway.close();
});
process.on('uncaughtException', (err) => log('uncaught:', err?.stack ?? err));
