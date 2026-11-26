const { app, BrowserWindow, dialog, ipcMain, screen, session, shell } = require('electron');
const { startContainers, stopContainers } = require('./containers.cjs');
const { createServiceWatch } = require('./service-watch.cjs');
const { readGeneratedMedia, resolveGeneratedMedia } = require('./media-access.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execSync, exec, execFile, spawn } = require('child_process');
const { createVoiceControl } = require('./voice-control.cjs');
const { createLocalVoice } = require('./local-voice.cjs');

let voiceControl = null;
let localVoice = null;
let stopWatchdog = () => {};
const PROXY_VERSION = '2.8.7';
// Neural voice: prefer the private voice venv (friday-hud/voice/setup.sh), else PATH.
const EDGE_TTS_VENV = path.join(os.homedir(), '.friday', 'voice-venv', 'bin', 'edge-tts');
const EDGE_TTS_BIN = fs.existsSync(EDGE_TTS_VENV) ? EDGE_TTS_VENV : 'edge-tts';

// Gemini key for speech-to-text: env var, or a single line in ~/.friday/credentials/gemini_api_key.
function readGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.friday', 'credentials', 'gemini_api_key'), 'utf8').trim();
  } catch {
    return '';
  }
}

// Single-instance lock — if another FRIDAY widget is already running, focus it and quit
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[FRIDAY] Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to open a second instance — focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow;

// Track CPU usage across samples
let lastCpuIdle = 0;
let lastCpuTotal = 0;

function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((acc, v) => acc + v, 0);
    return { idle, total };
  } catch (e) {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) {
      for (const t in c.times) total += c.times[t];
      idle += c.times.idle;
    }
    return { idle, total };
  }
}

const initialTimes = readCpuTimes();
lastCpuIdle = initialTimes.idle;
lastCpuTotal = initialTimes.total;

function getCpuPercent() {
  const current = readCpuTimes();
  const idleDiff = current.idle - lastCpuIdle;
  const totalDiff = current.total - lastCpuTotal;
  lastCpuIdle = current.idle;
  lastCpuTotal = current.total;
  if (totalDiff <= 0) return null; // no new sample yet: unknown, not a made-up number
  const usage = Math.round((1 - idleDiff / totalDiff) * 100);
  return Math.max(0, Math.min(100, usage));
}

// Zero-overhead cached system telemetry
let cachedDisk = null;
let lastDiskCheck = 0;
let cachedGpu = null;
let lastGpuCheck = 0;

function getDiskPercent() {
  const now = Date.now();
  if (now - lastDiskCheck < 60000) return cachedDisk;
  lastDiskCheck = now;
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync('/');
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize; // space available to the user, matching `df`
      cachedDisk = Math.round(((total - free) / total) * 100);
    }
  } catch (e) {}
  return cachedDisk;
}

function getGpuPercent() {
  const now = Date.now();
  if (now - lastGpuCheck < 10000) return cachedGpu;
  lastGpuCheck = now;

  try {
    // Check if NVIDIA card is asleep (suspended) to avoid waking it and wasting battery
    const dgpuStatusPath = '/sys/class/drm/card2/device/power/runtime_status';
    if (fs.existsSync(dgpuStatusPath)) {
      const status = fs.readFileSync(dgpuStatusPath, 'utf8').trim();
      if (status === 'suspended') {
        cachedGpu = 0; // discrete GPU is asleep: genuinely idle (not sampled, so it stays asleep)
        return cachedGpu;
      }
    }

    // If active, sample gently
    const nvOut = execSync("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null", { encoding: 'utf8', timeout: 800 }).trim();
    const parsed = parseInt(nvOut, 10);
    cachedGpu = Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    cachedGpu = null;
  }
  return cachedGpu;
}

function getSystemStats() {
  const cpu = getCpuPercent();
  // MemAvailable counts reclaimable cache as free (what `free -h` calls "available").
  let ram = null;
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = Number((/MemTotal:\s+(\d+)/.exec(mem) || [])[1]);
    const avail = Number((/MemAvailable:\s+(\d+)/.exec(mem) || [])[1]);
    if (total) ram = Math.round(((total - avail) / total) * 100);
  } catch (e) {}
  const disk = getDiskPercent();
  const gpu = getGpuPercent();

  let battery = null;
  try {
    for (const bat of ['/sys/class/power_supply/BAT0/capacity', '/sys/class/power_supply/BAT1/capacity']) {
      if (fs.existsSync(bat)) {
        battery = parseInt(fs.readFileSync(bat, 'utf8').trim());
        break;
      }
    }
  } catch (err) {}

  return {
    cpu,
    ram,
    disk,
    gpu,
    battery,
    uptime: Math.floor(os.uptime()),
    platform: 'linux',
    hostname: os.hostname(),
    loadAvg: Number(os.loadavg()[0].toFixed(2))
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'friday-widget');
const BOUNDS_FILE = path.join(CONFIG_DIR, 'bounds.json');

function saveBounds(bounds) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(bounds), 'utf8');
  } catch (e) {}
}

function loadSavedBounds() {
  try {
    if (fs.existsSync(BOUNDS_FILE)) {
      return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function pinWindowToDesktop(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    // Pin to X11 desktop layer, sticky on all workspaces, skip dock/taskbar and alt-tab
    execSync("wmctrl -r 'FRIDAY — YOUR PERSONAL AGI' -b add,sticky 2>/dev/null || true");
    execSync("wmctrl -r 'FRIDAY — YOUR PERSONAL AGI' -b remove,below 2>/dev/null || true");
    execSync("wmctrl -r 'FRIDAY — YOUR PERSONAL AGI' -b add,skip_taskbar,skip_pager 2>/dev/null || true");
  } catch (err) {}
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const saved = loadSavedBounds();
  // Default to compact desk widget on right side of desktop
  let initWidth = saved && saved.width ? saved.width : 560;
  let initHeight = saved && saved.height ? saved.height : 720;
  let posX = saved && saved.x !== undefined ? saved.x : Math.max(0, width - 580);
  let posY = saved && saved.y !== undefined ? saved.y : Math.max(0, Math.round((height - 720) / 2));

  const args = process.argv.join(' ');
  if (args.includes('--size=mini') || args.includes('--mini')) {
    initWidth = 560;
    initHeight = 720;
    posX = Math.max(0, width - 580);
    posY = Math.max(0, Math.round((height - 720) / 2));
  } else if (args.includes('--size=med') || args.includes('--med')) {
    initWidth = 1150;
    initHeight = 740;
    posX = Math.max(0, Math.round((width - 1150) / 2));
    posY = Math.max(0, Math.round((height - 740) / 2));
  } else if (args.includes('--size=full') || args.includes('--full')) {
    initWidth = Math.min(1920, width);
    initHeight = Math.min(1080, height);
    posX = 0;
    posY = 0;
  }

  // A saved position from another screen/scale must not leave part of the window off-screen.
  initWidth = Math.min(initWidth, width);
  initHeight = Math.min(initHeight, height);
  posX = Math.max(0, Math.min(posX, width - initWidth));
  posY = Math.max(0, Math.min(posY, height - initHeight));

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    x: posX,
    y: posY,
    minWidth: 420,
    minHeight: 320,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true, // Crucial: Never appear as a running app in taskbar/dock
    type: 'utility',   // Desktop widget window type
    backgroundColor: '#00000000',
    title: 'FRIDAY — YOUR PERSONAL AGI',
    icon: path.join(__dirname, '../public/friday-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      // A hidden or covered HUD must keep its timers running: the gateway heartbeat, reconnects and
      // streaming replies all depend on them, or the chat "goes to sleep" until it is focused.
      backgroundThrottling: false,
    },
  });

  mainWindow.setOpacity(1.0);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // Debounced bounds saver
  let boundsTimer = null;
  const debouncedSaveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        saveBounds(mainWindow.getBounds());
      }
    }, 200);
  };
  mainWindow.on('move', debouncedSaveBounds);
  mainWindow.on('resize', debouncedSaveBounds);

  // Disable backdrop-filter blur BEFORE resize paints (prevents X11 compositor freeze)
  let resizeBlurTimer = null;
  mainWindow.on('will-resize', () => {
    mainWindow.webContents.executeJavaScript(
      `document.querySelector('.hud-root-container')?.classList.add('resizing')`
    ).catch(() => {});
    if (resizeBlurTimer) clearTimeout(resizeBlurTimer);
    resizeBlurTimer = setTimeout(() => {
      mainWindow.webContents.executeJavaScript(
        `document.querySelector('.hud-root-container')?.classList.remove('resizing')`
      ).catch(() => {});
    }, 250);
  });
  mainWindow.on('resize', () => {
    mainWindow.webContents.executeJavaScript(
      `document.querySelector('.hud-root-container')?.classList.add('resizing')`
    ).catch(() => {});
    if (resizeBlurTimer) clearTimeout(resizeBlurTimer);
    resizeBlurTimer = setTimeout(() => {
      mainWindow.webContents.executeJavaScript(
        `document.querySelector('.hud-root-container')?.classList.remove('resizing')`
      ).catch(() => {});
    }, 250);
  });

  mainWindow.webContents.on('console-message', (event, level, message, line) => {
    console.log(`[HUD RENDERER ${level}] ${message} (${line})`);
  });

  // Recover instead of leaving a blank or frozen window.
  let reloads = [];
  const reloadSoon = (why) => {
    const now = Date.now();
    reloads = reloads.filter((t) => now - t < 60_000);
    if (reloads.length >= 3 || !mainWindow || mainWindow.isDestroyed()) return; // avoid a reload loop
    reloads.push(now);
    console.warn(`[HUD] reloading view: ${why}`);
    setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.reload(), 600);
  };
  mainWindow.webContents.on('render-process-gone', (_e, details) => reloadSoon(`renderer gone (${details.reason})`));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reloadSoon(`load failed (${desc})`);
  });
  mainWindow.on('unresponsive', () => console.warn('[HUD] window unresponsive'));
  mainWindow.on('responsive', () => console.warn('[HUD] window responsive again'));

  mainWindow.once('ready-to-show', () => {
    pinWindowToDesktop(mainWindow);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => pinWindowToDesktop(mainWindow), 200);
    setTimeout(() => pinWindowToDesktop(mainWindow), 800);
  });

  const hudUrl = process.env.HUD_URL;
  const distIndex = path.join(__dirname, '../dist/index.html');

  if (hudUrl) {
    mainWindow.loadURL(hudUrl);
  } else if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex);
  } else {
    mainWindow.loadURL('http://localhost:18790');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Automatically permit microphone and media stream access
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true);
    }
    callback(true);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return true;
  });

  // IPC Handlers
  ipcMain.handle('system:get-stats', () => getSystemStats());
  // ABILITIES tab: Sir picks which folders FRIDAY may read, and opens his local automation editor.
  ipcMain.handle('abilities:pick-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for FRIDAY to read',
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });
  ipcMain.handle('abilities:open-editor', async () => {
    // Only the local n8n, never an address from the page.
    await shell.openExternal('http://127.0.0.1:18961');
    return true;
  });

  // Media FRIDAY generated (images, video, audio, PDFs): show them in chat, save a copy, or reveal the file.
  // Only files inside her generated/ folder (see media-access.cjs).
  ipcMain.handle('media:read', async (_e, file) => {
    try { return { ok: true, ...readGeneratedMedia(file) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  ipcMain.handle('media:reveal', async (_e, file) => {
    try { shell.showItemInFolder(resolveGeneratedMedia(file)); return true; } catch { return false; }
  });
  ipcMain.handle('media:save-as', async (_e, file) => {
    try {
      const real = resolveGeneratedMedia(file);
      const res = await dialog.showSaveDialog(mainWindow, { title: 'Save media', defaultPath: path.join(os.homedir(), 'Downloads', path.basename(real)) });
      if (res.canceled || !res.filePath) return false;
      fs.copyFileSync(real, res.filePath);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:set-always-on-top', (event, flag) => {
    mainWindow?.setAlwaysOnTop(Boolean(flag));
    return mainWindow?.isAlwaysOnTop();
  });

  ipcMain.handle('window:set-size', (event, { width, height }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: maxW, height: maxH } = primaryDisplay.workAreaSize;
    const targetW = Math.max(420, Math.min(width, maxW));
    const targetH = Math.max(320, Math.min(height, maxH));

    let targetX = 0;
    let targetY = 0;
    if (targetW < maxW) {
      targetX = Math.max(0, maxW - targetW - 24);
      targetY = Math.max(0, Math.round((maxH - targetH) / 2));
    }

    // Atomic resize and reposition in a single X11 XConfigureWindow call
    mainWindow.setBounds({
      x: targetX,
      y: targetY,
      width: targetW,
      height: targetH,
    });

    saveBounds({ x: targetX, y: targetY, width: targetW, height: targetH });
    return mainWindow.getSize();
  });

  ipcMain.handle('window:get-size', () => {
    return mainWindow?.getSize() || [560, 720];
  });

  ipcMain.handle('window:set-desktop-mode', (event, isDesktop) => {
    if (!mainWindow) return false;
    try {
      if (isDesktop) {
        pinWindowToDesktop(mainWindow);
      } else {
        mainWindow.setAlwaysOnTop(true);
        execSync("wmctrl -r 'FRIDAY — YOUR PERSONAL AGI' -b remove,below 2>/dev/null || true");
      }
      return true;
    } catch (err) {
      return false;
    }
  });

  // Gateway status and lifecycle controls
  function checkGatewayPort(port = 18789, host = '127.0.0.1', timeout = 1000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }

  function getGatewayConfig() {
    try {
      const cfgPath = path.join(os.homedir(), '.friday', 'friday.json');
      if (fs.existsSync(cfgPath)) {
        const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const port = data.gateway?.port || 18789;
        const token = data.gateway?.auth?.token || '';
        const workspaceDir = data.agents?.defaults?.workspace || '';
        return { port, token, workspaceDir };
      }
    } catch (e) {}
    // No hard-coded fallback: the token lives only in ~/.friday/friday.json.
    return { port: 18789, token: '' };
  }

  // Real projects: git repositories under the home folder (read-only git queries, cached 60 s).
  const execFileP = (cmd, args, opts) =>
    new Promise((resolve) => execFile(cmd, args, { timeout: 4000, ...opts }, (err, stdout) => resolve(err ? '' : String(stdout))));
  const findRepos = (dir, depth, out) => {
    if (out.length >= 40 || depth > 2) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    if (entries.some((e) => e.name === '.git')) { out.push(dir); return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'snap', 'venv'].includes(e.name)) {
        findRepos(path.join(dir, e.name), depth + 1, out);
      }
    }
  };
  const detectTech = (dir) => {
    const tech = [];
    const has = (f) => fs.existsSync(path.join(dir, f));
    try {
      if (has('package.json')) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const [k, label] of [['next', 'Next.js'], ['react', 'React'], ['electron', 'Electron'], ['vite', 'Vite'], ['express', 'Express'], ['typescript', 'TypeScript'], ['three', 'Three.js']]) {
          if (deps[k]) tech.push(label);
        }
        if (!tech.length) tech.push('Node.js');
      }
    } catch (e) {}
    if (has('pyproject.toml') || has('requirements.txt')) tech.push('Python');
    if (has('Cargo.toml')) tech.push('Rust');
    if (has('go.mod')) tech.push('Go');
    if (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle.kts')) tech.push('Android/Gradle');
    if (has('Dockerfile') || has('docker-compose.yml')) tech.push('Docker');
    return [...new Set(tech)].slice(0, 5);
  };
  const describe = (dir) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.description) return String(pkg.description).slice(0, 140);
    } catch (e) {}
    for (const f of ['README.md', 'readme.md', 'README']) {
      try {
        const line = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
          .map((l) => l.replace(/[#>*_`\[\]]/g, '').trim())
          .find((l) => l.length > 20 && !/^(!|<|http)/.test(l));
        if (line) return line.slice(0, 140);
      } catch (e) {}
    }
    return '';
  };
  let projectsCache = { at: 0, list: [] };
  ipcMain.handle('projects:list', async () => {
    if (Date.now() - projectsCache.at < 60000) return projectsCache.list;
    const repos = [];
    findRepos(os.homedir(), 0, repos);
    const list = await Promise.all(repos.map(async (dir) => {
      const [statusOut, logOut] = await Promise.all([
        execFileP('git', ['-C', dir, 'status', '-sb', '--porcelain']),
        execFileP('git', ['-C', dir, 'log', '-1', '--format=%ct%x09%s']),
      ]);
      const [header = '', ...rest] = statusOut.split('\n');
      const [ts, ...msg] = logOut.trim().split('\t');
      return {
        path: dir,
        name: path.basename(dir),
        description: describe(dir),
        branch: (/^## ([^.\s]+)/.exec(header) || [])[1] || '',
        lastCommitAt: Number(ts) ? Number(ts) * 1000 : null,
        lastCommitMessage: msg.join('\t').slice(0, 120),
        uncommitted: rest.filter((l) => l.trim()).length,
        ahead: Number((/ahead (\d+)/.exec(header) || [])[1] || 0),
        behind: Number((/behind (\d+)/.exec(header) || [])[1] || 0),
        tech: detectTech(dir),
      };
    }));
    list.sort((a, b) => (b.lastCommitAt || 0) - (a.lastCommitAt || 0));
    projectsCache = { at: Date.now(), list };
    return list;
  });

  // Autonomy kill switch: same file the `friday autonomy pause|resume` CLI uses.
  const autonomyFile = path.join(os.homedir(), '.friday', 'autonomy.json');
  ipcMain.handle('autonomy:get', async () => {
    try { return { paused: JSON.parse(fs.readFileSync(autonomyFile, 'utf8')).paused === true }; }
    catch (e) { return { paused: false }; }
  });
  ipcMain.handle('autonomy:set', async (event, paused) => {
    const next = { paused: Boolean(paused), changedAt: Date.now(), reason: 'HUD toggle' };
    fs.mkdirSync(path.dirname(autonomyFile), { recursive: true });
    fs.writeFileSync(autonomyFile + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(autonomyFile + '.tmp', autonomyFile);
    return { paused: next.paused };
  });

  ipcMain.handle('gateway:get-info', async () => {
    const cfg = getGatewayConfig();
    const running = await checkGatewayPort(cfg.port);
    // FRIDAY's own version for the header badge; the underlying model stays confidential.
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version || ''; } catch (e) {}
    return { running, port: cfg.port, token: cfg.token, version, workspaceDir: cfg.workspaceDir || '' };
  });

  // --- Initialise FRIDAY, step by step (driven by the startup screen) -----------------------
  // Nothing starts at login or when the window opens; each step starts its service only if it
  // isn't already running and reports what actually happened.
  const repoRootDir = path.resolve(__dirname, '../../');
  const waitFor = async (check, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  // Alive = the proxy answers HTTP at all. Its front page is local and instant; /v1/models makes
  // a live call to Google (1-2 s, and a 500 whenever Google hiccups), which is not "the engine is dead".
  const brainAnswers = async () => {
    try {
      await fetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  };
  const startTmux = (name, command) =>
    new Promise((resolve) => {
      execFile('tmux', ['kill-session', '-t', name], () => {
        execFile('tmux', ['new-session', '-d', '-s', name, command], (err) => resolve(!err));
      });
    });

  async function startBrain() {
    if (await brainAnswers()) return { ok: true, already: true, ms: 0 };
    const started = Date.now();
    // Pinned: @latest would execute whatever was last published to npm.
    // Raise the proxy's hard-coded 16k Gemini output cap first (re-applied after npx re-downloads).
    const patchScript = path.join(repoRootDir, 'scripts', 'patch-antigravity-proxy.sh');
    await startTmux(
      'friday-proxy',
      `bash -l -c 'bash "${patchScript}" ${PROXY_VERSION}; npx -y antigravity-claude-proxy@${PROXY_VERSION} start'`,
    );
    const ok = await waitFor(brainAnswers, 120000);
    return ok ? { ok, ms: Date.now() - started } : { ok, error: 'The reasoning engine did not answer within 2 minutes (tmux session friday-proxy).' };
  }

  async function startGatewayService() {
    const cfg = getGatewayConfig();
    if (await checkGatewayPort(cfg.port)) return { ok: true, already: true, ms: 0 };
    const started = Date.now();
    await startTmux('friday', `cd '${repoRootDir}' && bash -l -c 'pnpm friday gateway --force'`);
    const ok = await waitFor(() => checkGatewayPort(cfg.port), 90000);
    return ok ? { ok, ms: Date.now() - started } : { ok, error: 'The gateway did not start within 90 s (tmux session friday).' };
  }

  // --- Self-repair while FRIDAY is initialised ------------------------------------------------
  // See service-watch.cjs: one start at a time, only services seen up, several misses in a row.
  const notify = (payload) => mainWindow?.webContents.send('friday:service-event', { at: Date.now(), ...payload });
  const watch = createServiceWatch({
    intervalMs: 10000,
    notify,
    isShuttingDown: () => shuttingDown,
    services: {
      brain: { isUp: brainAnswers, restart: startBrain, misses: 3 },
      gateway: { isUp: () => checkGatewayPort(getGatewayConfig().port, '127.0.0.1', 2500), restart: startGatewayService, misses: 3 },
    },
  });
  const startWatchdog = () => watch.startWatchdog();
  stopWatchdog = () => watch.stopWatchdog();


  ipcMain.handle('boot:step', async (event, step) => {
    const started = Date.now();
    try {
      // Any start-up step means FRIDAY is meant to be running: keep her healthy from now on.
      startWatchdog();
      if (step === 'brain') return await watch.start('brain');
      if (step === 'gateway') {
        // Search and automations start alongside, in the background: INITIALIZE doesn't wait.
        void startContainers().catch((err) => console.warn('[FRIDAY] containers:', err?.message || err));
        return await watch.start('gateway');
      }
      if (step === 'voice') {
        localVoice ??= createLocalVoice();
        const state = await localVoice.waitReady(120000);
        return { ok: state.stt || state.tts, ms: Date.now() - started, ...state };
      }
      return { ok: false, error: `unknown step ${step}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('gateway:start', async () => {
    try {
      startWatchdog();
      const brain = await watch.start('brain');
      if (!brain.ok) return { success: false, running: false, error: brain.error };
      void startContainers().catch((err) => console.warn('[FRIDAY] containers:', err?.message || err));
      const gw = await watch.start('gateway');
      return { success: gw.ok, running: gw.ok, error: gw.error };
    } catch (err) {
      return { success: false, running: false, error: err.message };
    }
  });

  ipcMain.handle('gateway:stop', async () => {
    try {
      watch.disarm('gateway'); // stopped on purpose: don't bring it back
      const stopBin = path.join(os.homedir(), '.local', 'bin', 'friday-stop');
      if (fs.existsSync(stopBin)) {
        execSync(`bash "${stopBin}" 2>/dev/null || true`);
      } else {
        // By port and session, as on shutdown (a `pkill -f` pattern would match its own shell).
        await stopPids(await pidsOnPort(getGatewayConfig().port), 8000);
        await killTmuxSession('friday');
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // High-performance Non-Blocking Browser & System Media Control (MPRIS2 / playerctl)
  let cachedMediaStatus = { active: false, isPlaying: false };
  let lastMediaFetchTime = 0;

  function fetchMediaStatusAsync() {
    return new Promise((resolve) => {
      const now = Date.now();
      if (now - lastMediaFetchTime < 600) {
        return resolve(cachedMediaStatus);
      }
      lastMediaFetchTime = now;

      exec(
        "playerctl metadata --format '{{status}}<delim>{{playerName}}<delim>{{artist}}<delim>{{title}}<delim>{{mpris:artUrl}}<delim>{{position}}<delim>{{mpris:length}}' 2>/dev/null",
        { timeout: 750 },
        (err, stdout) => {
          if (err || !stdout || !stdout.trim()) {
            cachedMediaStatus = { active: false, isPlaying: false };
            return resolve(cachedMediaStatus);
          }
          try {
            const parts = stdout.trim().split('<delim>');
            const status = (parts[0] || '').trim();
            const player = (parts[1] || 'browser').trim();
            const artist = (parts[2] || 'Browser Audio').trim();
            const title = (parts[3] || 'Media Track').trim();
            const artUrl = (parts[4] || '').trim();
            const position = parseInt(parts[5]) || 0;
            const length = parseInt(parts[6]) || 0;
            cachedMediaStatus = {
              active: true,
              isPlaying: status.toLowerCase() === 'playing',
              player,
              status,
              artist,
              title,
              artUrl,
              position,
              length,
            };
          } catch (e) {
            cachedMediaStatus = { active: false, isPlaying: false };
          }
          resolve(cachedMediaStatus);
        }
      );
    });
  }

  ipcMain.handle('media:get-status', async () => {
    return await fetchMediaStatusAsync();
  });

  ipcMain.handle('media:play-pause', () => {
    return new Promise((resolve) => {
      if (cachedMediaStatus.active) {
        cachedMediaStatus.isPlaying = !cachedMediaStatus.isPlaying;
      }
      exec('playerctl play-pause 2>/dev/null || true', () => {
        lastMediaFetchTime = 0;
        resolve(true);
      });
    });
  });

  ipcMain.handle('media:next', () => {
    return new Promise((resolve) => {
      exec('playerctl next 2>/dev/null || true', () => {
        lastMediaFetchTime = 0;
        resolve(true);
      });
    });
  });

  ipcMain.handle('media:previous', () => {
    return new Promise((resolve) => {
      exec('playerctl previous 2>/dev/null || true', () => {
        lastMediaFetchTime = 0;
        resolve(true);
      });
    });
  });

  // Advanced Neural Human-Like Voice Synthesis (Edge-TTS Irish F.R.I.D.A.Y Voice)
  const TTS_CACHE_DIR = path.join(os.tmpdir(), 'friday_tts');
  if (!fs.existsSync(TTS_CACHE_DIR)) {
    try { fs.mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch (e) {}
  }

  ipcMain.handle('voice:synthesize-speech', async (event, { text, voice = 'en-IE-EmilyNeural' }) => {
    if (!text || !text.trim()) return { success: false, error: 'Empty text' };

    // Clean text for natural conversational speech synthesis
    let cleanText = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~#|]/g, '')
      .replace(/[^\x00-\x7F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanText) return { success: false, error: 'No speakable text' };

    // Local Kokoro voice first (offline, ~0.3x real time); the cloud voice below is the fallback.
    try {
      const wav = await localVoice?.synthesize(cleanText);
      if (wav) return { success: true, audioBase64: wav, mimeType: 'audio/wav', text: cleanText, engine: 'local' };
    } catch (e) {
      console.warn('[TTS] local voice failed, using cloud voice:', e.message);
    }
    // The cloud voice can't do expression tags.
    cleanText = cleanText.replace(/\s*<(sigh|breath|laugh)>\s*/gi, ' ').trim();
    if (!cleanText) return { success: false, error: 'No speakable text' };

    const hash = crypto.createHash('md5').update(cleanText + voice).digest('hex').slice(0, 16);
    const audioFile = path.join(TTS_CACHE_DIR, `speech_${hash}.mp3`);

    // Audio bytes are returned too, so the renderer can play them from a same-origin blob
    // and analyse the waveform (file:// media would be cross-origin to Web Audio).
    const ok = () => {
      let audioBase64;
      try { audioBase64 = fs.readFileSync(audioFile).toString('base64'); } catch (e) {}
      return { success: true, audioUrl: `file://${audioFile}`, audioBase64, mimeType: 'audio/mpeg', text: cleanText };
    };

    // Check disk cache
    if (fs.existsSync(audioFile)) {
      try {
        if (fs.statSync(audioFile).size > 100) return ok();
      } catch (e) {}
    }

    // Call edge-tts with an argument vector: the text is model output, so it must never
    // pass through a shell ($(...) and backticks would execute inside double quotes).
    return new Promise((resolve) => {
      execFile(
        EDGE_TTS_BIN,
        ['--voice', String(voice), '--text', cleanText, '--write-media', audioFile],
        { timeout: 10000 },
        (err) => {
          if (err || !fs.existsSync(audioFile)) {
            return resolve({ success: false, fallback: true, text: cleanText });
          }
          resolve(ok());
        },
      );
    });
  });

  // FRIDAY's 3D character: friday.vrm in ~/.friday/avatar (or the first .vrm there).
  ipcMain.handle('avatar:load', async () => {
    const dir = path.join(os.homedir(), '.friday', 'avatar');
    try {
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.vrm')).sort();
      const name = files.includes('friday.vrm') ? 'friday.vrm' : files[0];
      return name ? fs.promises.readFile(path.join(dir, name)) : null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('voice:endpoint', async () => (localVoice ? localVoice.endpoint() : { vadUrl: null, stt: false, tts: false }));

  ipcMain.handle('voice:cancel', () => {
    return true;
  });

  // High-accuracy Neural Speech-to-Text Transcription via Gemini 2.5 Flash
  ipcMain.handle('voice:transcribe-audio', async (event, { base64Audio, mimeType = 'audio/webm' }) => {
    try {
      if (!base64Audio) return { success: false, error: 'Empty audio data' };

      // Local Whisper first: accurate and offline. '' means it heard no speech at all.
      try {
        const local = await localVoice?.transcribe(base64Audio);
        if (typeof local === 'string') return { success: true, text: local, engine: 'local', heardNothing: !local };
      } catch (e) {
        console.warn('[STT] local whisper failed, trying cloud:', e.message);
      }

      // Never embed keys in source (this repo is public). Without a key the renderer
      // falls back to the offline Vosk transcript.
      const apiKey = readGeminiKey();
      if (!apiKey) return { success: false, error: 'no-gemini-key' };
      const cleanMime = (mimeType || 'audio/webm').split(';')[0];

      const payload = JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: base64Audio,
                },
              },
              {
                text: 'Transcribe the spoken audio verbatim in English. Do not add any conversational replies, timestamps, notes, or explanations. Return ONLY the transcribed text.',
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.0,
        },
      });

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.warn('[STT] Gemini transcription error:', res.status, errText);
        return { success: false, error: `Transcription API error: ${res.status}` };
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      console.log('[STT] Transcribed user voice query:', text);
      return { success: true, text };
    } catch (err) {
      console.error('[STT] Transcription failed:', err);
      return { success: false, error: err.message };
    }
  });

  // Autonomous Assistant & Google Workspace IPC
  // These scripts need the Google client libraries, which live in the Google MCP venv.
  const googleVenv = path.join(os.homedir(), '.friday', 'mcp', 'google', 'venv', 'bin', 'python');
  const GOOGLE_PYTHON = fs.existsSync(googleVenv) ? googleVenv : 'python3';
  const gwScript = path.join(os.homedir(), '.friday', 'services', 'google_workspace.py');
  const plannerScript = path.join(os.homedir(), '.friday', 'services', 'assistant_planner.py');

  ipcMain.handle('assistant:get-agenda', async () => {
    try {
      const agendaPath = path.join(os.homedir(), '.friday', 'agenda.json');
      if (fs.existsSync(agendaPath)) {
        const raw = fs.readFileSync(agendaPath, 'utf8');
        return JSON.parse(raw);
      }
      return new Promise((resolve) => {
        execFile(GOOGLE_PYTHON, [plannerScript, 'get'], { timeout: 15000 }, (err, stdout) => {
          if (err) return resolve({ briefing: '', agenda: [] });
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            resolve({ briefing: '', agenda: [] });
          }
        });
      });
    } catch (e) {
      return { briefing: '', agenda: [] };
    }
  });

  ipcMain.handle('assistant:plan-day', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [plannerScript, 'plan', '--speak'], { timeout: 30000 }, (err, stdout) => {
        if (err) {
          console.error('[PLANNER] Exec error:', err);
          return resolve({ success: false, error: err.message });
        }
        try {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            resolve({ success: true, ...data });
          } else {
            resolve({ success: true });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('assistant:get-workspace-status', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'status'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ authenticated: false });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ authenticated: false });
        }
      });
    });
  });

  ipcMain.handle('assistant:login-google', async () => {
    const child = spawn(GOOGLE_PYTHON, [gwScript, 'login'], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  });

  ipcMain.handle('assistant:set-direct-auth', async (event, { email, appPassword, calendarUrl = '' }) => {
    return new Promise((resolve) => {
      const sanitizedEmail = (email || '').replace(/"/g, '');
      const sanitizedPass = (appPassword || '').replace(/"/g, '').replace(/\s+/g, '');
      const sanitizedCal = (calendarUrl || '').replace(/"/g, '');
      execFile(GOOGLE_PYTHON, [gwScript, 'set-auth', sanitizedEmail, sanitizedPass, sanitizedCal], { timeout: 5000 }, (err) => {
        if (err) return resolve({ success: false, error: err.message });
        resolve({ success: true });
      });
    });
  });

  ipcMain.handle('assistant:get-unread-emails', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'unread-emails'], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve([]);
        }
      });
    });
  });

  ipcMain.handle('assistant:get-events', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'today-events'], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve([]);
        }
      });
    });
  });

  ipcMain.handle('assistant:get-auth-url', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'get-auth-url'], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ url: '' });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ url: '' });
        }
      });
    });
  });

  ipcMain.handle('workspace:list-drive-files', async (event, maxResults = 20) => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'drive-files', String(Number(maxResults) || 20)], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve([]);
        }
      });
    });
  });

  ipcMain.handle('workspace:search-drive', async (event, query, maxResults = 20) => {
    return new Promise((resolve) => {
      const sanitized = (query || '');
      execFile(GOOGLE_PYTHON, [gwScript, 'drive-search', sanitized, String(Number(maxResults) || 20)], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve([]);
        }
      });
    });
  });

  ipcMain.handle('workspace:create-doc', async (event, title, content = '') => {
    return new Promise((resolve) => {
      const sTitle = (title || 'Untitled Document');
      const sContent = (content || '');
      execFile(GOOGLE_PYTHON, [gwScript, 'create-doc', sTitle, sContent], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('workspace:read-doc', async (event, docId) => {
    return new Promise((resolve) => {
      const sId = (docId || '').replace(/"/g, '');
      execFile(GOOGLE_PYTHON, [gwScript, 'read-doc', sId], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('workspace:create-sheet', async (event, title) => {
    return new Promise((resolve) => {
      const sTitle = (title || 'Untitled Spreadsheet');
      execFile(GOOGLE_PYTHON, [gwScript, 'create-sheet', sTitle], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('workspace:get-tasks', async () => {
    return new Promise((resolve) => {
      execFile(GOOGLE_PYTHON, [gwScript, 'tasks'], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve([]);
        }
      });
    });
  });

  ipcMain.handle('workspace:create-task', async (event, title, notes = '') => {
    return new Promise((resolve) => {
      const sTitle = (title || '');
      const sNotes = (notes || '');
      execFile(GOOGLE_PYTHON, [gwScript, 'create-task', sTitle, sNotes], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('workspace:complete-task', async (event, taskId) => {
    return new Promise((resolve) => {
      const sId = (taskId || '').replace(/"/g, '');
      execFile(GOOGLE_PYTHON, [gwScript, 'complete-task', sId], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('workspace:open-app', async (event, appName) => {
    return new Promise((resolve) => {
      const sApp = (appName || 'drive').replace(/"/g, '');
      execFile(GOOGLE_PYTHON, [gwScript, 'open-app', sApp], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: true, app: sApp });
        }
      });
    });
  });

  ipcMain.handle('workspace:set-client-credentials', async (event, clientId, clientSecret) => {
    return new Promise((resolve) => {
      const sId = (clientId || '');
      const sSec = (clientSecret || '');
      execFile(GOOGLE_PYTHON, [gwScript, 'set-client', sId, sSec], { timeout: 10000 }, (err, stdout) => {
        if (err) return resolve({ success: false, error: err.message });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: true });
        }
      });
    });
  });

  // Memory IPC
  const memoryScript = path.join(os.homedir(), '.friday', 'services', 'memory_engine.py');
  ipcMain.handle('memory:query', async (event, query) => {
    return new Promise((resolve) => {
      const sanitized = (query || '');
      execFile('python3', [memoryScript, 'query', sanitized], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ latency_ms: 0, matched_nodes: [], associations: [] });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ latency_ms: 0, matched_nodes: [], associations: [] });
        }
      });
    });
  });

  // Helper for Python service calls with JSON IPC
  const callPythonService = (scriptPath, action, args = {}, timeoutMs = 30000) => {
    return new Promise((resolve) => {
      execFile('python3', [scriptPath, String(action), JSON.stringify(args)], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) return resolve({ success: false, error: err.message, stderr });
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          resolve({ success: true, raw: stdout.trim() });
        }
      });
    });
  };

  const osScript = path.join(os.homedir(), '.friday', 'services', 'os_controller.py');
  const browserScript = path.join(os.homedir(), '.friday', 'services', 'browser_engine.py');
  const oppScript = path.join(os.homedir(), '.friday', 'services', 'opportunity_scout.py');

  // Tier 1: OS Controller IPC Handlers
  ipcMain.handle('os:exec-command', async (event, params) => callPythonService(osScript, 'exec', params, 60000));
  ipcMain.handle('os:read-file', async (event, params) => callPythonService(osScript, 'read_file', params));
  ipcMain.handle('os:write-file', async (event, params) => callPythonService(osScript, 'write_file', params));
  ipcMain.handle('os:list-dir', async (event, params) => callPythonService(osScript, 'list_dir', params));
  ipcMain.handle('os:delete-path', async (event, params) => callPythonService(osScript, 'delete', params));
  ipcMain.handle('os:clipboard-read', async () => callPythonService(osScript, 'clipboard_read', {}));
  ipcMain.handle('os:clipboard-write', async (event, text) => callPythonService(osScript, 'clipboard_write', { text }));
  ipcMain.handle('os:screenshot', async (event, params) => callPythonService(osScript, 'screenshot', params || {}));
  ipcMain.handle('os:type-text', async (event, params) => callPythonService(osScript, 'type', params));
  ipcMain.handle('os:press-key', async (event, key) => callPythonService(osScript, 'press_key', { key }));
  ipcMain.handle('os:open-app', async (event, app) => callPythonService(osScript, 'open_app', { app }));
  ipcMain.handle('os:list-windows', async () => callPythonService(osScript, 'list_windows', {}));
  ipcMain.handle('os:focus-window', async (event, query) => callPythonService(osScript, 'focus_window', { query }));
  ipcMain.handle('os:notify', async (event, params) => callPythonService(osScript, 'notify', params));

  // Tier 2: Browser Engine IPC Handlers
  ipcMain.handle('browser:navigate', async (event, url) => callPythonService(browserScript, 'navigate', { url }, 45000));
  ipcMain.handle('browser:search', async (event, query, maxResults) => callPythonService(browserScript, 'search', { query, max_results: maxResults || 8 }));
  ipcMain.handle('browser:extract', async (event, url, maxChars) => callPythonService(browserScript, 'extract', { url, max_chars: maxChars || 20000 }));
  ipcMain.handle('browser:screenshot', async (event, url, outPath) => callPythonService(browserScript, 'screenshot', { url, output_path: outPath }));

  // Autonomous Opportunity & Work Engine IPC Handlers
  ipcMain.handle('opportunity:scan', async () => callPythonService(oppScript, 'scan', {}, 30000));
  ipcMain.handle('opportunity:list', async (event, status, limit) => callPythonService(oppScript, 'list', { status, limit: limit || 20 }));
  ipcMain.handle('opportunity:prepare', async (event, id) => callPythonService(oppScript, 'prepare', { id }));
  ipcMain.handle('opportunity:get-workspace', async (event, id) => callPythonService(oppScript, 'get_workspace', { id }));
  ipcMain.handle('opportunity:open-workspace', async (event, id, app) => callPythonService(oppScript, 'open_workspace', { id, app: app || 'code' }));
  ipcMain.handle('opportunity:solve', async (event, id) => callPythonService(oppScript, 'solve', { id }, 60000));
  ipcMain.handle('opportunity:stage', async (event, params) => callPythonService(oppScript, 'stage', params));
  ipcMain.handle('opportunity:approve', async (event, id) => callPythonService(oppScript, 'approve', { id }));
  ipcMain.handle('opportunity:complete', async (event, id, earned) => callPythonService(oppScript, 'complete', { id, earned_usd: earned }));
  ipcMain.handle('opportunity:stats', async () => callPythonService(oppScript, 'stats', {}));

  // Additional Tiers: Communication, Dev Tools, Knowledge
  const commsScript = path.join(os.homedir(), '.friday', 'services', 'messaging_hub.py');
  const knowledgeScript = path.join(os.homedir(), '.friday', 'services', 'knowledge_engine.py');
  const devScript = path.join(os.homedir(), '.friday', 'services', 'dev_tools.py');

  // Tier 3: Communication
  ipcMain.handle('comms:send-email', async (event, params) => callPythonService(commsScript, 'send_email', params));
  ipcMain.handle('comms:create-event', async (event, params) => callPythonService(commsScript, 'create_event', params));
  ipcMain.handle('comms:notify', async (event, params) => callPythonService(commsScript, 'notify', params));

  // Tier 4: Dev Tools
  ipcMain.handle('dev:git-status', async (event, path) => callPythonService(devScript, 'git_status', { path }));
  ipcMain.handle('dev:git-commit', async (event, params) => callPythonService(devScript, 'git_commit', params));
  ipcMain.handle('dev:git-log', async (event, path, count) => callPythonService(devScript, 'git_log', { path, count: count || 5 }));
  ipcMain.handle('dev:docker-status', async () => callPythonService(devScript, 'docker', {}));
  ipcMain.handle('dev:run-tests', async (event, params) => callPythonService(devScript, 'test', params));

  // Tier 5: Knowledge Engine
  ipcMain.handle('knowledge:search', async (event, query, maxResults) => callPythonService(knowledgeScript, 'search', { query, max_results: maxResults || 8 }));
  ipcMain.handle('knowledge:arxiv', async (event, query, maxResults) => callPythonService(knowledgeScript, 'arxiv', { query, max_results: maxResults || 5 }));
  ipcMain.handle('knowledge:analyze-pdf', async (event, path, maxPages) => callPythonService(knowledgeScript, 'pdf', { path, max_pages: maxPages || 20 }));

  createWindow();

  // Wake word, live transcript and push-to-talk socket.
  voiceControl = createVoiceControl({ getWindow: () => mainWindow, ipcMain });
  // The local voice models load when FRIDAY is initialised (boot:voice), not when the window opens.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --- Closing the app shuts FRIDAY down completely ------------------------------------------
// Sir's choice: FRIDAY only runs while the app is open. On quit we stop, in order: the voice
// stack (wake word, Whisper, Kokoro/Silero), the gateway (WhatsApp, heartbeat, reminders,
// commitment scans, MCP tools such as the browser; it closes those cleanly on SIGTERM) and the
// reasoning engine. Each gets a graceful SIGTERM first and SIGKILL if it hangs.

/** PIDs listening on a local TCP port (via ss). */
function pidsOnPort(port) {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnpH', `sport = :${port}`], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve([...new Set([...String(stdout).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))]);
    });
  });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopPids(pids, graceMs) {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + graceMs;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  for (const pid of pids.filter(isAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

const killTmuxSession = (name) => new Promise((resolve) => execFile('tmux', ['kill-session', '-t', name], () => resolve()));

async function shutdownFriday() {
  stopWatchdog(); // don't 'repair' services we are deliberately stopping
  voiceControl?.dispose();
  localVoice?.dispose();
  const gatewayPort = (() => {
    try { return getGatewayConfig().port; } catch { return 18789; }
  })();
  // Gateway first (it may still be using the reasoning engine), then the engine.
  await stopPids(await pidsOnPort(gatewayPort), 8000);
  await killTmuxSession('friday');
  await stopPids(await pidsOnPort(8080), 4000);
  await killTmuxSession('friday-proxy');
  await stopContainers();
}

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  // Never hang on exit: whatever happens, quit within 15 s.
  const hardStop = setTimeout(() => app.exit(0), 15000);
  shutdownFriday()
    .catch((err) => console.warn('[FRIDAY] shutdown:', err?.message || err))
    .finally(() => {
      clearTimeout(hardStop);
      app.exit(0);
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
