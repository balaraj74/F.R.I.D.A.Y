// Microphone capture, speech-to-text (whisper.cpp) and speech output (Supertonic).
// Same engines and settings as the HUD; see friday-hud/electron/local-voice.cjs.
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cleanForSpeech} from './speak-text.mjs';

const MAX_RECORD_MS = 30_000;
// Same finish as the HUD's voice: a little chest and presence, softened sibilance, no echo.
const WARMTH =
  'highpass=f=70,equalizer=f=200:t=q:w=1.1:g=2,equalizer=f=3200:t=q:w=1.4:g=1.5,equalizer=f=7500:t=q:w=1.5:g=-2.5,acompressor=threshold=-22dB:ratio=1.8:attack=15:release=250:makeup=1.5,alimiter=limit=0.92';
const NOISE = /^\s*[[(]?\s*(blank_audio|silence|music|inaudible|no speech|sound|noise)[^\])]*[\])]?\s*$/i;

export function readVoiceSettings(file = path.join(os.homedir(), '.friday', 'voice.json')) {
  const defaults = {supertonicVoice: 'F1', supertonicSpeed: 0.9, warmth: true};
  try {
    return {...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8'))};
  } catch {
    return defaults;
  }
}

/** Records the default microphone to a 16 kHz mono WAV until stop() is called. */
export class Recorder {
  constructor(dir) {
    this.dir = dir;
    this.child = null;
    this.file = null;
    this.timer = null;
  }

  get active() {
    return !!this.child;
  }

  start() {
    if (this.child) return this.file;
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    this.file = path.join(this.dir, `rec-${Date.now()}.wav`);
    this.child = spawn('pw-record', ['--rate', '16000', '--channels', '1', '--format', 's16', this.file], {stdio: 'ignore'});
    this.exited = new Promise((resolve) => {
      this.child.once('exit', resolve);
      this.child.once('error', resolve);
    });
    this.timer = setTimeout(() => this.stop().catch(() => {}), MAX_RECORD_MS);
    return this.file;
  }

  /** Stops recording and resolves with the WAV path (null when nothing was recorded). */
  async stop() {
    if (!this.child) return null;
    clearTimeout(this.timer);
    const {child, file, exited} = this;
    this.child = null;
    child.kill('SIGINT'); // lets pw-record finish the WAV header
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    return fs.existsSync(file) && fs.statSync(file).size > 1600 ? file : null;
  }
}

/** Whisper transcript of a 16 kHz mono WAV, or '' when nothing intelligible was heard. */
export async function transcribe(sttBase, wavPath) {
  const wav = fs.readFileSync(wavPath);
  const seconds = Math.max(0.2, (wav.length - 44) / 32000);
  const form = new FormData();
  form.append('file', new Blob([wav], {type: 'audio/wav'}), 'speech.wav');
  form.append('response_format', 'json');
  form.append('audio_ctx', String(Math.min(1500, Math.ceil(seconds * 50) + 128)));
  const res = await fetch(`${sttBase}/inference`, {method: 'POST', body: form, signal: AbortSignal.timeout(30_000)});
  if (!res.ok) throw new Error(`speech recognition failed (HTTP ${res.status})`);
  const text = String((await res.json()).text ?? '').replace(/\s+/g, ' ').trim();
  return NOISE.test(text) ? '' : text;
}

function warm(wav) {
  return new Promise((resolve) => {
    const child = execFile(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-af', WARMTH, '-f', 'wav', 'pipe:1'],
      {encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 5000},
      (err, stdout) => resolve(err || !stdout.length ? wav : stdout),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(wav);
  });
}

function expressiveSpeed(text, base) {
  const t = text.toLowerCase();
  let k = 1;
  if (/<sigh>|<breath>|\b(miss(ed)? you|goodnight|good night|sleep well|love|proud of you|i'm here|take care|rest)\b/.test(t)) k = 0.94;
  else if (/<laugh>|!/.test(t)) k = 1.05;
  else if (/\?\s*$/.test(t)) k = 1.02;
  return Math.round(base * k * 100) / 100;
}

/** Plays one WAV at a time; a new request or stop() cuts the current one off. */
export class Speaker {
  constructor(dir) {
    this.dir = dir;
    this.child = null;
    this.generation = 0;
  }

  stop() {
    this.generation++;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /** @param {() => Promise<{base:string, headers:object}|null>} getTts */
  async say(text, getTts) {
    const spoken = cleanForSpeech(text);
    if (!spoken) return false;
    this.stop();
    const mine = this.generation;
    const tts = await getTts();
    if (!tts || mine !== this.generation) return false;
    const settings = readVoiceSettings();
    const res = await fetch(`${tts.base}/tts`, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...tts.headers},
      body: JSON.stringify({
        text: spoken,
        voice: settings.supertonicVoice,
        speed: expressiveSpeed(spoken, settings.supertonicSpeed),
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res?.ok || mine !== this.generation) return false;
    let wav = Buffer.from(await res.arrayBuffer());
    if (settings.warmth !== false) wav = await warm(wav);
    if (mine !== this.generation) return false;
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    const file = path.join(this.dir, `say-${Date.now()}.wav`);
    fs.writeFileSync(file, wav);
    const player = process.env.FRIDAY_QUICKBAR_PLAYER || 'paplay';
    return new Promise((resolve) => {
      const child = spawn(player, [file], {stdio: 'ignore'});
      this.child = child;
      const finish = (ok) => {
        if (this.child === child) this.child = null;
        fs.rm(file, () => {});
        resolve(ok);
      };
      child.once('exit', (code) => finish(code === 0));
      child.once('error', () => finish(false));
    });
  }
}
