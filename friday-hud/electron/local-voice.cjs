// Local voice stack, all offline and on this machine:
//   whisper.cpp server  (speech-to-text, Whisper small.en + Silero VAD trimming)  127.0.0.1:18950
//   voice-server.mjs    (Kokoro text-to-speech + streaming Silero VAD)            127.0.0.1:18951
// Installed under ~/.friday/voice by voice/setup-local.sh. If anything is missing the HUD
// falls back to the cloud voice (edge-tts) and cloud/Vosk transcription, as before.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plat = require('./platform.cjs');

const VOICE_DIR = path.join(os.homedir(), '.friday', 'voice');
// Linux: built from source (build/bin). Windows: prebuilt release binary, which may sit in a few places.
const WHISPER_BIN = plat.isWindows
  ? [
      ['whisper-server.exe'],
      ['build', 'bin', 'whisper-server.exe'],
      ['build', 'bin', 'Release', 'whisper-server.exe'],
      ['Release', 'whisper-server.exe'],
    ]
      .map((parts) => path.join(VOICE_DIR, 'whisper.cpp', ...parts))
      .find((p) => fs.existsSync(p)) || path.join(VOICE_DIR, 'whisper.cpp', 'whisper-server.exe')
  : path.join(VOICE_DIR, 'whisper.cpp', 'build', 'bin', 'whisper-server');
// A smaller model is used on CPU-only Windows machines when small.en was not installed.
const WHISPER_MODEL = (plat.isWindows
  ? ['ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin']
      .map((m) => path.join(VOICE_DIR, 'whisper.cpp', 'models', m))
      .find((p) => fs.existsSync(p))
  : null) || path.join(VOICE_DIR, 'whisper.cpp', 'models', 'ggml-small.en.bin');
const WHISPER_VAD = path.join(VOICE_DIR, 'whisper.cpp', 'models', 'ggml-silero-v5.1.2.bin');
const NODE_DIR = path.join(VOICE_DIR, 'node');
const STT_PORT = 18950; // clear of the gateway's 18789-18793 and 18800-18899
const VOICE_PORT = 18951;
const SUPERTONIC_PORT = 18952;
const SUPERTONIC_PY = plat.venvPython(path.join(VOICE_DIR, 'supertonic', 'venv'));
const SETTINGS_FILE = path.join(os.homedir(), '.friday', 'voice.json');

// Sir's choice: Supertonic F1 (Bella as fallback) with the soft finish. ~/.friday/voice.json overrides.
const DEFAULT_SETTINGS = {
  engine: 'local',
  ttsModel: 'supertonic', // 'supertonic' (expressive) or 'kokoro'
  supertonicVoice: 'F1',
  supertonicSpeed: 0.9,
  kokoroVoice: 'af_bella',
  speed: 0.92,
  warmth: true,
  expressive: true,
};
// Close, warm and clear: a little chest (200 Hz) and presence (3.2 kHz), softened sibilance,
// gentle levelling. No echo: the old 28 ms echo comb-filtered the voice and made it metallic.
const WARMTH = 'highpass=f=70,equalizer=f=200:t=q:w=1.1:g=2,equalizer=f=3200:t=q:w=1.4:g=1.5,equalizer=f=7500:t=q:w=1.5:g=-2.5,acompressor=threshold=-22dB:ratio=1.8:attack=15:release=250:makeup=1.5,alimiter=limit=0.92';

/**
 * A person doesn't say every sentence at one tempo. Tender lines (a sigh, "miss you", goodnight)
 * come slower; playful or excited ones (a laugh, "!") a touch quicker; questions lift slightly.
 * Small steps (about 5%) so it reads as feeling, not as a different voice.
 */
function expressiveSpeed(text, base) {
  const t = text.toLowerCase();
  let k = 1;
  if (/<sigh>|<breath>|\b(miss(ed)? you|goodnight|good night|sleep well|love|proud of you|i'm here|take care|rest)\b/.test(t)) k = 0.94;
  else if (/<laugh>|!/.test(t)) k = 1.05;
  else if (/\?\s*$/.test(t)) k = 1.02;
  return Math.round(base * k * 100) / 100;
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function findNode() {
  if (plat.isWindows) return 'node'; // resolved through PATH (node.exe)
  for (const p of ['/usr/local/bin/node', '/usr/bin/node']) if (fs.existsSync(p)) return p;
  return 'node';
}

function createLocalVoice() {
  // Always-on mode (scripts/always-on.sh) runs the voice servers as systemd services that share one
  // token, published in runtime.json with "managed": true. Then the HUD joins them instead of
  // starting its own copies, and leaves them running when it closes.
  const RUNTIME_FILE = path.join(VOICE_DIR, 'runtime.json');
  let managed = null;
  try {
    const found = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (found && found.managed === true && typeof found.token === 'string' && found.token) managed = found;
  } catch {
    // no managed runtime
  }
  const token = managed ? managed.token : crypto.randomBytes(16).toString('hex');
  const procs = {};
  // A service counts as available when we started it, or when always-on mode runs it for us.
  const has = (name) => Boolean(procs[name]) || managed !== null;
  let disposed = false;
  // Lets the desktop quick bar reuse these servers while the HUD is open (owner-only file).
  if (!managed) try {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    fs.writeFileSync(
      RUNTIME_FILE,
      JSON.stringify({ token, pid: process.pid, ports: { stt: STT_PORT, kokoro: VOICE_PORT, supertonic: SUPERTONIC_PORT } }),
      { mode: 0o600 },
    );
  } catch {
    // The quick bar then starts its own voice servers.
  }

  /** Any HTTP answer (even an error status) means something is serving that port. */
  const portAnswers = (port) =>
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  function supervise(name, cmd, args, opts, port) {
    let restarts = 0;
    const start = () => {
      if (disposed) return;
      const child = spawn(cmd, args, { ...opts, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      procs[name] = child;
      let tail = '';
      child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
      child.on('exit', (code) => {
        procs[name] = null;
        if (disposed) return;
        restarts += 1;
        const lastLine = tail.trim().split('\n').filter((l) => l.length < 300).pop() || '';
        console.warn(`[voice] ${name} exited (${code}); ${lastLine}`);
        if (restarts <= 5) setTimeout(start, Math.min(30000, 2000 * restarts));
      });
    };
    if (managed && port) {
      // The always-on service should already be serving; only start our own if it is not.
      setTimeout(async () => {
        if (!disposed && !(await portAnswers(port))) start();
      }, 4000);
    } else {
      start();
    }
  }

  const sttAvailable = fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
  const voiceAvailable = fs.existsSync(path.join(NODE_DIR, 'node_modules', 'kokoro-js'));

  if (sttAvailable) {
    const args = ['-m', WHISPER_MODEL, '--host', '127.0.0.1', '--port', String(STT_PORT), '-t', '8', '-bs', '1', '-bo', '1', '-fa'];
    if (fs.existsSync(WHISPER_VAD)) args.push('--vad', '--vad-model', WHISPER_VAD);
    supervise('whisper', WHISPER_BIN, args, {}, STT_PORT);
  }
  if (voiceAvailable) {
    // Keep the server script in the repo; run it next to its dependencies.
    try {
      fs.copyFileSync(path.join(__dirname, '..', 'voice', 'voice-server.mjs'), path.join(NODE_DIR, 'voice-server.mjs'));
    } catch (e) {
      console.warn('[voice] could not install voice-server.mjs:', e.message);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    supervise('kokoro', findNode(), [path.join(NODE_DIR, 'voice-server.mjs')], {
      cwd: NODE_DIR,
      env: {
        ...env,
        FRIDAY_VOICE_PORT: String(VOICE_PORT),
        FRIDAY_VOICE_TOKEN: token,
        FRIDAY_VAD_MODEL: path.join(VOICE_DIR, 'models', 'silero_vad.onnx'),
      },
    }, VOICE_PORT);
  }

  const supertonicAvailable = fs.existsSync(SUPERTONIC_PY);
  if (supertonicAvailable) {
    supervise('supertonic', SUPERTONIC_PY, [path.join(__dirname, '..', 'voice', 'supertonic-server.py')], {
      env: { ...process.env, FRIDAY_SUPERTONIC_PORT: String(SUPERTONIC_PORT), FRIDAY_VOICE_TOKEN: token },
    }, SUPERTONIC_PORT);
  }

  async function supertonicReady() {
    try {
      const res = await fetch(`http://127.0.0.1:${SUPERTONIC_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      return Boolean((await res.json()).tts);
    } catch {
      return false;
    }
  }

  async function voiceHealth() {
    try {
      const res = await fetch(`http://127.0.0.1:${VOICE_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      return await res.json();
    } catch {
      return null;
    }
  }

  /** WAV 16 kHz mono from whatever MediaRecorder produced (webm/opus). */
  function toWav16k(input) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'ffmpeg',
        ['-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin.end(input);
    });
  }

  // Whisper's quirks on silence/noise, never something Sir said.
  const NOISE = /^\s*[\[(]?\s*(blank_audio|silence|music|inaudible|no speech|sound|noise)[^\])]*[\])]?\s*$/i;

  /** Local Whisper transcript, or null when unavailable / nothing heard. */
  async function transcribe(base64Audio) {
    if (!sttAvailable || !has('whisper')) return null;
    const wav = await toWav16k(Buffer.from(base64Audio, 'base64'));
    const seconds = Math.max(0, (wav.length - 44) / 32000);
    // Size Whisper's window to the clip (50 frames per second): short commands decode ~3x faster.
    const audioCtx = Math.min(1500, Math.ceil(seconds * 50) + 128);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('audio_ctx', String(audioCtx));
    const res = await fetch(`http://127.0.0.1:${STT_PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`whisper ${res.status}`);
    const data = await res.json();
    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
    if (!text || NOISE.test(text)) return '';
    return text;
  }

  /** Local Kokoro speech as WAV base64, or null to fall back to the cloud voice. */
  async function ttsRequest(port, body) {
    const res = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-friday-voice-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }

  async function synthesize(text) {
    const settings = readSettings();
    if (settings.engine === 'edge') return null;
    let wav = null;
    // Supertonic first: it can actually sigh and laugh. Only it gets the <tags>.
    if (settings.ttsModel !== 'kokoro' && has('supertonic')) {
      const speed = settings.expressive === false ? settings.supertonicSpeed : expressiveSpeed(text, settings.supertonicSpeed);
      wav = await ttsRequest(SUPERTONIC_PORT, { text, voice: settings.supertonicVoice, speed }).catch(() => null);
    }
    if (!wav && voiceAvailable && has('kokoro')) {
      const plain = text.replace(/\s*<(sigh|breath|laugh)>\s*/gi, ' ').trim();
      if (plain) wav = await ttsRequest(VOICE_PORT, { text: plain, voice: settings.kokoroVoice, speed: settings.speed || 1 }).catch(() => null);
    }
    if (!wav) return null;
    if (settings.warmth === false) return wav.toString('base64');
    return (await warm(wav).catch(() => wav)).toString('base64');
  }

  function warm(wav) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'ffmpeg',
        ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', WARMTH, '-f', 'wav', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 5000, windowsHide: true },
        (err, stdout) => (err || !stdout.length ? reject(err || new Error('empty')) : resolve(stdout)),
      );
      child.stdin.end(wav);
    });
  }

  /** Wait until the models are loaded (or give up after timeoutMs). */
  async function waitReady(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let state = { stt: false, tts: false, vad: false };
    while (Date.now() < deadline) {
      const health = voiceAvailable ? await voiceHealth() : null;
      let stt = false;
      if (sttAvailable) {
        try {
          stt = (await fetch(`http://127.0.0.1:${STT_PORT}/`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {}
      }
      state = { stt, tts: Boolean(health?.tts), vad: Boolean(health?.vad) };
      if (supertonicAvailable && readSettings().ttsModel !== 'kokoro') state.tts = await supertonicReady();
      const want = { stt: sttAvailable, tts: voiceAvailable || supertonicAvailable, vad: voiceAvailable };
      if ((!want.stt || state.stt) && (!want.tts || state.tts) && (!want.vad || state.vad)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ...state, installed: { stt: sttAvailable, tts: voiceAvailable || supertonicAvailable } };
  }

  return {
    transcribe,
    synthesize,
    waitReady,
    async endpoint() {
      const health = await voiceHealth();
      return {
        vadUrl: health?.vad ? `ws://127.0.0.1:${VOICE_PORT}/vad?token=${token}` : null,
        stt: sttAvailable && has('whisper'),
        tts: Boolean(health?.tts) && readSettings().engine !== 'edge',
      };
    },
    settings: readSettings,
    dispose() {
      disposed = true;
      if (!managed) {
        try {
          fs.rmSync(RUNTIME_FILE, { force: true });
        } catch {
          // already gone
        }
      }
      for (const p of Object.values(procs)) {
        if (!p) continue;
        if (plat.isWindows) void plat.killTree(p.pid);
        else p.kill('SIGTERM');
      }
    },
  };
}

module.exports = { createLocalVoice };
