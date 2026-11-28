'use strict';
// First-run setup: the plan (step list), GPU detection, setup.json persistence and the step runner.
// Everything here is pure or takes its side effects as parameters (fs, exec, clock, platform), so
// it is unit-tested on Linux. The Electron/IPC wiring is in setup-ipc.cjs.
const path = require('node:path');

const SETUP_VERSION = 1;
const PROXY_VERSION = '2.8.7';
const PROXY_URL = 'http://127.0.0.1:8080';
const PORTS = { gateway: 18789, proxy: 8080, whisper: 18950, kokoro: 18951, supertonic: 18952 };

const TTS_CHOICES = ['edge', 'supertonic-gpu', 'none'];

// Approximate download sizes (MB) shown before the user confirms (requirement 6.1).
const DOWNLOAD_MB = {
  'whisper-cpu': 142 + 1 + 2 + 5, // base.en + silero VAD (ggml) + silero onnx + whisper binaries
  'whisper-gpu': 466 + 1 + 2 + 600, // small.en + VAD + onnx + cuBLAS build
  'supertonic-gpu': 2500, // Supertonic model + onnxruntime-gpu + CUDA libraries
  'computer-control': 60,
};

/* ------------------------------------------------------------------ GPU detection */

/**
 * Decide whether an NVIDIA GPU is present from command output given as text.
 * `nvidiaSmi`: output of `nvidia-smi --query-gpu=name --format=csv,noheader` or the default table.
 * `wmi`: output of `Get-CimInstance Win32_VideoController | % Name` (one adapter per line) or
 * `wmic path win32_VideoController get name`.
 */
function detectGpu({ nvidiaSmi, wmi } = {}) {
  const smi = String(nvidiaSmi || '');
  // CSV form: a bare product name per line.
  for (const raw of smi.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(NVIDIA|GeForce|Quadro|Tesla|RTX|Titan)\b/i.test(line) && !/^NVIDIA-SMI\b/i.test(line)) {
      return { nvidia: true, name: line.replace(/^NVIDIA\s+/i, 'NVIDIA ').trim() };
    }
  }
  // Table form: "| N/A  NVIDIA GeForce RTX 3060 ...   WDDM | ..." or "|   0  NVIDIA GeForce RTX 3060  Off |".
  const table = smi.match(/\|\s*\d+\s+(NVIDIA [^|]*?)\s{2,}(?:On|Off|WDDM|TCC)\b/i);
  if (table) return { nvidia: true, name: table[1].trim() };
  for (const raw of String(wmi || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/nvidia/i.test(line) && !/^name$/i.test(line)) return { nvidia: true, name: line };
  }
  return { nvidia: false };
}

/** Preselected voice for a machine (requirements 2.3, 2.4). */
function defaultVoice(gpu) {
  return gpu && gpu.nvidia
    ? { tts: 'supertonic-gpu', stt: 'whisper-gpu' }
    : { tts: 'edge', stt: 'whisper-cpu' };
}

/** Voice choices the wizard offers; GPU voice only when an NVIDIA GPU was found. */
function voiceOptions(gpu) {
  const opts = [];
  if (gpu && gpu.nvidia) opts.push({ id: 'supertonic-gpu', label: 'Supertonic (GPU)', needsInternet: false });
  opts.push({ id: 'edge', label: 'Edge (Microsoft)', needsInternet: true });
  opts.push({ id: 'none', label: 'No voice', needsInternet: false });
  return opts;
}

/* ------------------------------------------------------------------ choices and state */

function defaultChoices({ gpu, name, address } = {}) {
  return {
    name: name || '',
    address: address || 'Boss',
    brain: 'antigravity',
    voice: defaultVoice(gpu),
    background: true,
    quickbar: true,
    computerControl: { consented: false },
  };
}

/**
 * Clean untrusted choices from the renderer. Only the Antigravity brain exists today; other brain
 * ids are ignored, never stored. The GPU voice is refused on a machine without an NVIDIA GPU.
 */
function normalizeChoices(raw, gpu) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const base = defaultChoices({ gpu });
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const out = { ...base };
  out.name = clean(r.name, 60);
  out.address = clean(r.address, 40) || base.address;
  let tts = r.voice && TTS_CHOICES.includes(r.voice.tts) ? r.voice.tts : base.voice.tts;
  if (tts === 'supertonic-gpu' && !(gpu && gpu.nvidia)) tts = 'edge';
  if (tts === 'none') {
    out.voice = { tts: 'none' };
  } else {
    out.voice = { tts, stt: gpu && gpu.nvidia ? 'whisper-gpu' : 'whisper-cpu' };
  }
  out.background = r.background !== false;
  out.quickbar = r.quickbar !== false;
  out.computerControl = { consented: Boolean(r.computerControl && r.computerControl.consented) };
  return out;
}

/** Steps for the chosen options, in run order. Adding a brain later only adds branches here. */
function buildPlan(choices) {
  const steps = [
    { id: 'config', label: 'Create your config and workspace', required: true },
    { id: 'proxy', label: 'Prepare the brain (Antigravity proxy)', required: true },
  ];
  const voice = choices.voice || { tts: 'none' };
  if (voice.tts !== 'none') {
    const cpu = voice.stt !== 'whisper-gpu';
    steps.push({
      id: 'voice-stt',
      label: 'Install speech to text (Whisper)',
      required: false,
      downloadMB: cpu ? DOWNLOAD_MB['whisper-cpu'] : DOWNLOAD_MB['whisper-gpu'],
    });
  }
  if (voice.tts === 'supertonic-gpu') {
    steps.push({
      id: 'voice-tts',
      label: 'Install the Supertonic voice (GPU)',
      required: false,
      downloadMB: DOWNLOAD_MB['supertonic-gpu'],
    });
  }
  if (choices.computerControl && choices.computerControl.consented) {
    steps.push({
      id: 'computer-control',
      label: 'Set up computer control',
      required: false,
      downloadMB: DOWNLOAD_MB['computer-control'],
    });
  }
  if (choices.background) {
    steps.push({ id: 'services', label: 'Start FRIDAY in the background', required: false });
  }
  return steps;
}

function totalDownloadMB(plan) {
  return plan.reduce((n, s) => n + (s.downloadMB || 0), 0);
}

/** The setup.json document for a fresh run. No secrets. */
function initialState(choices, gpu, plan) {
  const v = choices.voice || { tts: 'none' };
  const state = {
    version: SETUP_VERSION,
    brain: choices.brain || 'antigravity',
    voice: v.tts === 'none' ? { tts: 'none' } : { tts: v.tts, stt: v.stt },
    gpu: gpu && gpu.nvidia ? { nvidia: true, ...(gpu.name ? { name: gpu.name } : {}) } : { nvidia: false },
    computerControl: { consented: Boolean(choices.computerControl && choices.computerControl.consented) },
    quickbar: { enabled: choices.quickbar !== false },
    background: choices.background !== false,
    profile: { name: choices.name || '', address: choices.address || 'Boss' },
    steps: {},
  };
  if (state.computerControl.consented) state.computerControl.at = new Date().toISOString();
  for (const s of plan) state.steps[s.id] = 'pending';
  return state;
}

function isSetupComplete(state) {
  return Boolean(state && state.version === SETUP_VERSION && state.completedAt);
}

/** Id of the first step that is not done, or null. Failed steps count as incomplete. */
function firstIncomplete(state, plan) {
  for (const s of plan) {
    if ((state.steps || {})[s.id] !== 'done') return s.id;
  }
  return null;
}

/** Plan from a stored state (resume). Mirrors buildPlan from the saved choices. */
function planFromState(state) {
  const v = state.voice || { tts: 'none' };
  return buildPlan({
    voice: v,
    background: state.background !== false,
    computerControl: state.computerControl || { consented: false },
  });
}

/** Choices recovered from a stored state, to refill the wizard on resume. */
function choicesFromState(state) {
  return {
    name: (state.profile && state.profile.name) || '',
    address: (state.profile && state.profile.address) || 'Boss',
    brain: state.brain || 'antigravity',
    voice: state.voice || { tts: 'none' },
    background: state.background !== false,
    quickbar: !(state.quickbar && state.quickbar.enabled === false),
    computerControl: { consented: Boolean(state.computerControl && state.computerControl.consented) },
  };
}

/* ------------------------------------------------------------------ persistence */

/** setup.json store with atomic writes: temp file in the same folder, then rename over the target. */
function createStore({ fs, file, pid = process.pid }) {
  return {
    file,
    read() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    },
    write(state) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/* ------------------------------------------------------------------ runner */

/**
 * Runs the plan one step at a time, saving after each step so a closed wizard resumes at the first
 * incomplete step. `execStep(step, ctx)` resolves `{ok:true}` or `{ok:false,error}`; it never throws
 * (a throw is caught and treated as a failure).
 * A failed required step stops the run. A failed optional step is recorded and the run continues,
 * unless `stopOnFailure` is set (the wizard uses that to offer Retry/Skip, see `skip`).
 * setup.json gets `completedAt` only when every required step is done.
 */
function createRunner({ plan, state, store, execStep, notify = () => {}, now = () => new Date(), stopOnFailure = true }) {
  let cancelled = false;
  const save = () => store.write(state);
  const emit = (event) => {
    try {
      notify(event);
    } catch {
      /* a broken listener must not stop setup */
    }
  };
  const requiredDone = () => plan.filter((s) => s.required).every((s) => state.steps[s.id] === 'done');
  const finishIfReady = () => {
    const allSettled = plan.every((s) => state.steps[s.id] === 'done' || state.steps[s.id] === 'skipped');
    if (allSettled || (requiredDone() && plan.every((s) => state.steps[s.id] !== 'pending' && state.steps[s.id] !== 'running'))) {
      if (requiredDone()) {
        state.completedAt = now().toISOString();
        save();
        return true;
      }
    }
    return false;
  };

  async function runStep(step) {
    state.steps[step.id] = 'running';
    delete state.error;
    emit({ type: 'step', id: step.id, status: 'running' });
    let result;
    try {
      result = await execStep(step, { state, emit: (p) => emit({ type: 'progress', id: step.id, ...p }) });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (result && result.ok) {
      state.steps[step.id] = 'done';
      emit({ type: 'step', id: step.id, status: 'done' });
    } else {
      const error = (result && result.error) || 'Step failed';
      state.steps[step.id] = 'failed';
      state.lastError = { step: step.id, message: String(error).slice(0, 500) };
      emit({ type: 'step', id: step.id, status: 'failed', error: state.lastError.message });
    }
    save();
    return state.steps[step.id];
  }

  return {
    cancel() {
      cancelled = true;
    },
    /** Run every step that is not done (or skipped). Returns {complete, stoppedAt?}. */
    async run() {
      cancelled = false;
      for (const step of plan) {
        const st = state.steps[step.id];
        if (st === 'done' || st === 'skipped') continue;
        if (cancelled) return { complete: false, cancelled: true, stoppedAt: step.id };
        const status = await runStep(step);
        if (status === 'failed' && (step.required || stopOnFailure)) {
          return { complete: false, stoppedAt: step.id };
        }
      }
      const complete = finishIfReady();
      if (complete) emit({ type: 'complete', completedAt: state.completedAt });
      return { complete };
    },
    /** Run one failed step again, then carry on with the rest. */
    async retry(id) {
      const step = plan.find((s) => s.id === id);
      if (!step) return { complete: false, error: `Unknown step ${id}` };
      state.steps[id] = 'pending';
      return this.run();
    },
    /** Skip a failed optional step. Required steps cannot be skipped. */
    skip(id) {
      const step = plan.find((s) => s.id === id);
      if (!step || step.required) return false;
      state.steps[id] = 'skipped';
      delete state.lastError;
      save();
      emit({ type: 'step', id, status: 'skipped' });
      return true;
    },
  };
}

/* ------------------------------------------------------------------ step commands (data only) */

/**
 * The process to start for a step, or null for steps done in-process (config, services, MCP
 * registration). Pure: paths come from `ctx` so tests can use any platform.
 * ctx: { platform, repoRoot, home, voiceDir, gpu }.
 */
function stepCommand(step, ctx) {
  const win = ctx.platform === 'win32';
  const join = win ? path.win32.join : path.join;
  switch (step.id) {
    case 'proxy':
      return {
        file: win ? 'npx.cmd' : 'npx',
        args: ['-y', `antigravity-claude-proxy@${PROXY_VERSION}`, '--help'],
        cwd: ctx.repoRoot,
        shell: win, // npx.cmd needs a shell on Windows
        quiet: true,
      };
    case 'voice-stt':
    case 'voice-tts': {
      const stt = ctx.state && ctx.state.voice && ctx.state.voice.stt === 'whisper-gpu' ? 'gpu' : 'cpu';
      const tts = ctx.state && ctx.state.voice && ctx.state.voice.tts;
      const part = step.id === 'voice-stt' ? 'Stt' : 'Tts';
      const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(ctx.repoRoot, 'friday-hud', 'voice', 'setup-windows.ps1'),
        '-Part',
        part,
        '-SttDevice',
        stt,
        '-Tts',
        tts === 'supertonic-gpu' ? 'supertonic' : tts === 'edge' ? 'edge' : 'none',
      ];
      return { file: 'powershell.exe', args, cwd: ctx.repoRoot, progressPrefix: '##' };
    }
    case 'computer-control': {
      const venv = join(ctx.home, '.friday', 'mcp', 'desktop', 'venv');
      return { venv, requirements: ['mcp', 'mss', 'Pillow'] };
    }
    default:
      return null;
  }
}

/** Parse "##PROGRESS 40 Downloading model" / "##SIZE 142" lines from the voice installer. */
function parseProgressLine(line) {
  const m = /^##(PROGRESS|SIZE|STEP)\s+(.*)$/.exec(String(line).trim());
  if (!m) return null;
  if (m[1] === 'PROGRESS') {
    const p = /^(\d{1,3})\s*(.*)$/.exec(m[2]);
    return p ? { percent: Math.min(100, Number(p[1])), message: p[2] } : null;
  }
  if (m[1] === 'SIZE') return { sizeMB: Number(m[2]) || 0 };
  return { message: m[2] };
}

/* ------------------------------------------------------------------ config and workspace */

/** The gateway config written on first run. Mirrors install.sh (loopback only, random token). */
function buildFridayConfig({ token, workspace, timezone }) {
  return {
    gateway: { mode: 'local', port: PORTS.gateway, bind: 'loopback', auth: { token } },
    models: {
      providers: {
        'antigravity-proxy': {
          baseUrl: PROXY_URL,
          api: 'anthropic-messages',
          apiKey: 'antigravity-proxy',
          models: [
            { id: 'gemini-4-hydrogen-sonar', name: 'Gemini 4 Hydrogen Sonar', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 64000 },
            { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', reasoning: false, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 64000 },
          ],
        },
      },
    },
    agents: {
      defaults: {
        workspace,
        userTimezone: timezone || 'UTC',
        model: { primary: 'antigravity-proxy/gemini-4-hydrogen-sonar', fallbacks: ['antigravity-proxy/gemini-3.5-flash-lite'] },
        fastModel: 'antigravity-proxy/gemini-3.5-flash-lite',
      },
    },
  };
}

/** Add the desktop (computer control) MCP server to a config object. Returns a new object. */
function withDesktopMcp(config, { python, server }) {
  const mcp = { ...(config.mcp || {}) };
  mcp.servers = {
    ...(mcp.servers || {}),
    desktop: { command: python, args: [server], readOnly: ['screen_look'], timeoutMs: 120000 },
  };
  return { ...config, mcp };
}

function renderTemplate(text, vars) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/** Template files for a platform: Windows has its own folder, Linux keeps the base files. */
function templateSources(platform) {
  const names = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
  if (platform === 'win32') return { dir: 'windows', files: [...names, 'TOOLS.md'] };
  return { dir: '', files: names };
}

/**
 * Write the workspace from templates unless it already exists (never overwrites).
 * Returns {created:boolean}.
 */
function createWorkspace({ fs, repoRoot, workspace, platform, vars }) {
  if (fs.existsSync(path.join(workspace, 'SOUL.md'))) return { created: false };
  const { dir, files } = templateSources(platform);
  const src = path.join(repoRoot, 'templates', 'friday-workspace', dir);
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  for (const f of files) {
    const target = path.join(workspace, f);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, renderTemplate(fs.readFileSync(path.join(src, f), 'utf8'), vars));
  }
  return { created: true };
}

/** Create friday.json when missing; never touch an existing one. Returns {created}. */
function ensureFridayConfig({ fs, file, workspace, timezone, randomToken }) {
  if (fs.existsSync(file)) return { created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cfg = buildFridayConfig({ token: randomToken(), workspace, timezone });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return { created: true };
}

module.exports = {
  SETUP_VERSION,
  PROXY_VERSION,
  PORTS,
  detectGpu,
  defaultVoice,
  voiceOptions,
  defaultChoices,
  normalizeChoices,
  buildPlan,
  totalDownloadMB,
  initialState,
  isSetupComplete,
  firstIncomplete,
  planFromState,
  choicesFromState,
  createStore,
  createRunner,
  stepCommand,
  parseProgressLine,
  buildFridayConfig,
  withDesktopMcp,
  renderTemplate,
  templateSources,
  createWorkspace,
  ensureFridayConfig,
};
