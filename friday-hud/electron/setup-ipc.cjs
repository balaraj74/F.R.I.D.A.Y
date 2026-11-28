'use strict';
// IPC wiring for the setup wizard. Thin on purpose: all decisions live in setup.cjs.
// main.cjs hook (3 lines, after the window exists):
//   const setupIpc = require('./setup-ipc.cjs');
//   setupIpc.register({ ipcMain, shell, getWindow: () => mainWindow, repoRoot: path.join(__dirname, '..', '..') });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const setup = require('./setup.cjs');

function dirs(home = os.homedir()) {
  const friday = path.join(home, '.friday');
  return { home, friday, logs: path.join(friday, 'logs'), file: path.join(friday, 'setup.json') };
}

/** Should the HUD show the wizard? Linux only with --setup, so the owner's machine is unchanged. */
function needsSetup({ argv = process.argv, platform = process.platform, state = null } = {}) {
  if (argv.includes('--setup')) return !setup.isSetupComplete(state) || argv.includes('--setup-again');
  return platform === 'win32' && !setup.isSetupComplete(state);
}

function runCapture(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function detectGpuLive(platform = process.platform) {
  const nvidiaSmi = await runCapture('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  if (nvidiaSmi.trim() || platform !== 'win32') return setup.detectGpu({ nvidiaSmi });
  const wmi = await runCapture('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }',
  ]);
  return setup.detectGpu({ wmi });
}

function register({ ipcMain, shell, getWindow, repoRoot, home = os.homedir(), platform = process.platform }) {
  const d = dirs(home);
  const store = setup.createStore({ fs, file: d.file });
  let runner = null;
  let child = null;
  let logStream = null;
  let gpu = { nvidia: false };

  const send = (event) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('setup:event', event);
  };
  const log = (line) => {
    try {
      if (!logStream) {
        fs.mkdirSync(d.logs, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        logStream = fs.createWriteStream(path.join(d.logs, `setup-${stamp}.log`), { flags: 'a' });
      }
      logStream.write(`${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging must never break setup */
    }
  };

  /** Spawn a process, stream its output to the log and progress events. */
  function runProcess(spec, step, emit) {
    return new Promise((resolve) => {
      log(`$ ${spec.file} ${spec.args.join(' ')}`);
      let tail = '';
      try {
        child = spawn(spec.file, spec.args, { cwd: spec.cwd, shell: Boolean(spec.shell), windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      } catch (err) {
        resolve({ ok: false, error: `Could not start ${spec.file}: ${err.message}` });
        return;
      }
      const onData = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (!line) continue;
          log(line);
          tail = `${tail}\n${line}`.slice(-600);
          const p = setup.parseProgressLine(line);
          if (p) emit(p);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => resolve({ ok: false, error: `Could not run ${spec.file}: ${err.message}` }));
      child.on('close', (code) => {
        child = null;
        resolve(code === 0 ? { ok: true } : { ok: false, error: `${step.label} failed (exit ${code}). ${tail.trim().split('\n').pop() || ''}`.trim() });
      });
    });
  }

  function internalStep(step, state) {
    if (step.id === 'config') {
      const workspace = path.join(home, 'friday');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      setup.ensureFridayConfig({
        fs,
        file: path.join(d.friday, 'friday.json'),
        workspace,
        timezone: tz,
        randomToken: () => crypto.randomBytes(24).toString('base64url'),
      });
      setup.createWorkspace({
        fs,
        repoRoot,
        workspace,
        platform,
        vars: { NAME: state.profile.name || os.userInfo().username, ADDRESS: state.profile.address, TIMEZONE: tz },
      });
      const voiceFile = path.join(d.friday, 'voice.json');
      if (!fs.existsSync(voiceFile)) {
        const engine = state.voice.tts === 'supertonic-gpu' ? 'supertonic' : state.voice.tts === 'edge' ? 'edge' : 'edge';
        fs.writeFileSync(voiceFile, `${JSON.stringify({ ttsModel: engine, supertonicVoice: 'F1', supertonicSpeed: 0.9 }, null, 2)}\n`);
      }
      return { ok: true };
    }
    return null;
  }

  async function execStep(step, ctx) {
    const state = ctx.state;
    const internal = internalStep(step, state);
    if (internal) return internal;
    const cmdCtx = { platform, repoRoot, home, state, gpu };
    if (step.id === 'proxy') {
      const first = await runProcess(setup.stepCommand(step, cmdCtx), step, ctx.emit);
      if (!first.ok) return first;
      const patch = path.join(repoRoot, 'scripts', 'patch-antigravity-proxy.mjs');
      if (!fs.existsSync(patch)) return { ok: true }; // patch script ships with another track; proxy still starts
      return runProcess({ file: process.execPath, args: [patch, setup.PROXY_VERSION], cwd: repoRoot }, step, ctx.emit);
    }
    if (step.id === 'voice-stt' || step.id === 'voice-tts') {
      return runProcess(setup.stepCommand(step, cmdCtx), step, ctx.emit);
    }
    if (step.id === 'computer-control') return computerControl(step, ctx, cmdCtx);
    if (step.id === 'services') {
      const svc = path.join(repoRoot, 'scripts', 'friday-service.mjs');
      if (!fs.existsSync(svc)) return { ok: false, error: 'The background service tool is not installed (scripts/friday-service.mjs).' };
      for (const sub of ['install', 'start']) {
        const r = await runProcess({ file: process.execPath, args: [svc, sub], cwd: repoRoot }, step, ctx.emit);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    return { ok: false, error: `Unknown step ${step.id}` };
  }

  async function computerControl(step, ctx, cmdCtx) {
    const spec = setup.stepCommand(step, cmdCtx);
    const win = platform === 'win32';
    const python = win ? 'python' : 'python3';
    const venvPython = win ? path.win32.join(spec.venv, 'Scripts', 'python.exe') : path.join(spec.venv, 'bin', 'python');
    if (!fs.existsSync(venvPython)) {
      const r = await runProcess({ file: python, args: ['-m', 'venv', spec.venv], cwd: repoRoot }, step, ctx.emit);
      if (!r.ok) return r;
    }
    const pip = await runProcess({ file: venvPython, args: ['-m', 'pip', 'install', '--quiet', ...spec.requirements], cwd: repoRoot }, step, ctx.emit);
    if (!pip.ok) return pip;
    const cfgFile = path.join(d.friday, 'friday.json');
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (err) {
      return { ok: false, error: `Could not read friday.json to register computer control: ${err.message}` };
    }
    const next = setup.withDesktopMcp(cfg, { python: venvPython, server: path.join(repoRoot, 'mcp-servers', 'desktop', 'server.py') });
    const tmp = `${cfgFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, cfgFile);
    return { ok: true };
  }

  function startRun(choices, { fresh }) {
    const clean = setup.normalizeChoices(choices, gpu);
    const plan = setup.buildPlan(clean);
    const prev = store.read();
    const state = setup.initialState(clean, gpu, plan);
    // Resume: keep finished steps from an earlier, unfinished run with the same step ids.
    if (!fresh && prev && prev.steps) {
      for (const s of plan) if (prev.steps[s.id] === 'done') state.steps[s.id] = 'done';
    }
    store.write(state);
    runner = setup.createRunner({ plan, state, store, execStep, notify: (e) => { log(JSON.stringify(e)); send(e); } });
    runner.run().catch((err) => send({ type: 'error', error: err.message }));
    return { plan, state };
  }

  ipcMain.handle('setup:status', async () => {
    const state = store.read();
    gpu = await detectGpuLive(platform);
    const complete = setup.isSetupComplete(state);
    const resume = state && !complete && state.steps ? setup.planFromState(state) : null;
    return {
      needed: needsSetup({ state }),
      platform,
      gpu,
      voiceOptions: setup.voiceOptions(gpu),
      defaults: setup.defaultChoices({ gpu }),
      state,
      resume: resume ? { choices: setup.choicesFromState(state), plan: resume, firstIncomplete: setup.firstIncomplete(state, resume) } : null,
    };
  });
  ipcMain.handle('setup:plan', (_e, choices) => {
    const plan = setup.buildPlan(setup.normalizeChoices(choices, gpu));
    return { plan, totalMB: setup.totalDownloadMB(plan) };
  });
  ipcMain.handle('setup:start', (_e, choices) => startRun(choices, { fresh: false }));
  ipcMain.handle('setup:retry', (_e, id) => {
    if (!runner) return { ok: false };
    runner.retry(String(id)).catch((err) => send({ type: 'error', error: err.message }));
    return { ok: true };
  });
  ipcMain.handle('setup:skip', (_e, id) => {
    if (!runner || !runner.skip(String(id))) return { ok: false };
    runner.run().catch((err) => send({ type: 'error', error: err.message }));
    return { ok: true };
  });
  ipcMain.handle('setup:cancel', () => {
    if (runner) runner.cancel();
    if (child) child.kill();
    return { ok: true };
  });
  ipcMain.handle('setup:signin', () =>
    new Promise((resolve) => {
      const npx = platform === 'win32' ? 'npx.cmd' : 'npx';
      const p = spawn(npx, ['-y', `antigravity-claude-proxy@${setup.PROXY_VERSION}`, 'accounts', 'add'], {
        cwd: repoRoot,
        shell: platform === 'win32',
        windowsHide: true,
      });
      const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'Sign-in timed out. Try again.' }); }, 5 * 60 * 1000);
      p.stdout.on('data', (b) => log(`[signin] ${String(b).trim()}`));
      p.stderr.on('data', (b) => log(`[signin] ${String(b).trim()}`));
      p.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
      p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: `Sign-in did not finish (exit ${code}).` }); });
    }),
  );
  ipcMain.handle('setup:open-log', async () => {
    fs.mkdirSync(d.logs, { recursive: true });
    if (shell) await shell.openPath(d.logs);
    return { ok: true, path: d.logs };
  });
}

module.exports = { register, needsSetup, detectGpuLive, dirs };
