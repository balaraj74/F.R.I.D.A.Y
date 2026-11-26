// Starts the pieces the quick bar needs when the HUD is not open, and stops what it started
// when it has been idle. Mirrors how the HUD starts them (friday-hud/electron/main.cjs).
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const VOICE_DIR = path.join(HOME, '.friday', 'voice');
const PROXY_VERSION = '2.8.7';

// The HUD owns 18950-18952. The quick bar uses its own ports when it has to start its own copy.
export const PORTS = {hudStt: 18950, hudSupertonic: 18952, ownStt: 18960, ownSupertonic: 18962, brain: 8080};

export const tcpUp = (port, host = '127.0.0.1', timeoutMs = 600) =>
  new Promise((resolve) => {
    const sock = net.connect({port, host});
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });

export async function httpOk(url, init = {}, timeoutMs = 1500) {
  try {
    const res = await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs, stepMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

function tmuxStart(name, command) {
  return new Promise((resolve) => {
    execFile('tmux', ['kill-session', '-t', name], () => {
      execFile('tmux', ['new-session', '-d', '-s', name, command], (err) => resolve(!err));
    });
  });
}

function tmuxStop(name) {
  return new Promise((resolve) => execFile('tmux', ['kill-session', '-t', name], () => resolve()));
}

function hudRunning() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', 'friday-hud/node_modules/.*electron'], (err, out) => resolve(!err && out.trim().length > 0));
  });
}

export function readHudVoiceRuntime(file = path.join(VOICE_DIR, 'runtime.json')) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export class Services {
  constructor({repoDir, gatewayPort, log = () => {}}) {
    this.repoDir = repoDir;
    this.gatewayPort = gatewayPort;
    this.log = log;
    this.children = new Map();
    this.startedTmux = new Set();
    this.pending = new Map();
  }

  /** Runs `fn` once at a time per key; concurrent callers share the result. */
  _once(key, fn) {
    if (!this.pending.has(key)) {
      this.pending.set(key, fn().finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }

  async brainUp() {
    return !!(await httpOk(`http://127.0.0.1:${PORTS.brain}/`, {}, 3000));
  }

  /** Makes sure the brain proxy and the gateway answer. `status` receives short progress lines. */
  ensureGateway(status = () => {}) {
    return this._once('gateway', async () => {
      if (await tcpUp(this.gatewayPort)) return {ok: true};
      if (!(await this.brainUp())) {
        status('Starting the reasoning engine...');
        const patch = path.join(this.repoDir, 'scripts', 'patch-antigravity-proxy.sh');
        await tmuxStart(
          'friday-proxy',
          `bash -l -c 'bash "${patch}" ${PROXY_VERSION}; npx -y antigravity-claude-proxy@${PROXY_VERSION} start'`,
        );
        this.startedTmux.add('friday-proxy');
        if (!(await waitFor(() => this.brainUp(), 120_000, 1000))) {
          return {ok: false, error: 'The reasoning engine did not start within 2 minutes.'};
        }
      }
      status('Starting FRIDAY...');
      await tmuxStart('friday', `cd '${this.repoDir}' && bash -l -c 'pnpm friday gateway --force'`);
      this.startedTmux.add('friday');
      if (!(await waitFor(() => tcpUp(this.gatewayPort), 90_000, 700))) {
        return {ok: false, error: 'The gateway did not start within 90 seconds.'};
      }
      return {ok: true};
    });
  }

  _spawn(name, cmd, args, env = {}) {
    if (this.children.has(name)) return this.children.get(name);
    const child = spawn(cmd, args, {stdio: 'ignore', env: {...process.env, ...env}});
    child.once('exit', () => this.children.delete(name));
    child.once('error', () => this.children.delete(name));
    this.children.set(name, child);
    return child;
  }

  /** Base URL of a working speech-to-text server, or null. */
  ensureStt() {
    return this._once('stt', async () => {
      const hud = `http://127.0.0.1:${PORTS.hudStt}`;
      if (await httpOk(`${hud}/`)) return hud;
      const own = `http://127.0.0.1:${PORTS.ownStt}`;
      if (await httpOk(`${own}/`)) return own;
      const bin = path.join(VOICE_DIR, 'whisper.cpp', 'build', 'bin', 'whisper-server');
      const model = path.join(VOICE_DIR, 'whisper.cpp', 'models', 'ggml-small.en.bin');
      if (!fs.existsSync(bin) || !fs.existsSync(model)) return null;
      const args = ['-m', model, '--host', '127.0.0.1', '--port', String(PORTS.ownStt), '-t', '8', '-bs', '1', '-bo', '1', '-fa'];
      const vad = path.join(VOICE_DIR, 'whisper.cpp', 'models', 'ggml-silero-v5.1.2.bin');
      if (fs.existsSync(vad)) args.push('--vad', '--vad-model', vad);
      this._spawn('whisper', bin, args);
      return (await waitFor(() => httpOk(`${own}/`), 60_000, 500)) ? own : null;
    });
  }

  /** {base, headers} of a working Supertonic server, or null. */
  ensureTts() {
    return this._once('tts', async () => {
      const runtime = readHudVoiceRuntime();
      if (runtime?.token) {
        const base = `http://127.0.0.1:${runtime.ports?.supertonic ?? PORTS.hudSupertonic}`;
        const res = await httpOk(`${base}/health`);
        if (res && (await res.json().catch(() => ({}))).tts) {
          return {base, headers: {'x-friday-voice-token': runtime.token}};
        }
      }
      const base = `http://127.0.0.1:${PORTS.ownSupertonic}`;
      const ready = async () => {
        const res = await httpOk(`${base}/health`);
        return !!res && !!(await res.json().catch(() => ({}))).tts;
      };
      if (await ready()) return {base, headers: {}};
      const py = path.join(VOICE_DIR, 'supertonic', 'venv', 'bin', 'python');
      const script = path.join(this.repoDir, 'friday-hud', 'voice', 'supertonic-server.py');
      if (!fs.existsSync(py) || !fs.existsSync(script)) return null;
      // No token: this copy listens on loopback only and is private to the quick bar.
      this._spawn('supertonic', py, [script], {FRIDAY_SUPERTONIC_PORT: String(PORTS.ownSupertonic), FRIDAY_VOICE_TOKEN: ''});
      return (await waitFor(ready, 120_000, 700)) ? {base, headers: {}} : null;
    });
  }

  /** Stops the voice servers we started. */
  stopVoice() {
    for (const [name, child] of this.children) {
      child.kill('SIGTERM');
      this.children.delete(name);
    }
  }

  /** After a long idle: also stops the gateway and proxy, but only ones we started and only if the HUD is closed. */
  async stopAll({includeGateway = false} = {}) {
    this.stopVoice();
    if (includeGateway && !(await hudRunning())) {
      for (const name of this.startedTmux) await tmuxStop(name);
      this.startedTmux.clear();
    }
  }
}
