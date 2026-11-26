// FRIDAY local voice server (started by the HUD; localhost only, token-protected).
//   POST /tts  {text, voice?, speed?}  -> audio/wav  (Kokoro-82M, offline)
//   WS   /vad                           -> stream 16 kHz mono Float32 PCM in, get
//                                          {type:"speech-start"|"speech-end"|"level", p} out (Silero VAD)
//   GET  /health
// Runs from ~/.friday/voice/node (where its dependencies are installed); the HUD copies this
// file there before starting it.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KokoroTTS } from "kokoro-js";
import ort from "onnxruntime-node";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FRIDAY_VOICE_PORT || 18951);
const TOKEN = process.env.FRIDAY_VOICE_TOKEN || "";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAD_MODEL = process.env.FRIDAY_VAD_MODEL || path.join(HERE, "..", "models", "silero_vad.onnx");
const DEFAULT_VOICE = process.env.FRIDAY_KOKORO_VOICE || "bf_emma";

const log = (...a) => console.log("[voice]", ...a);

// --- TTS ------------------------------------------------------------------------------
// Kokoro is only the backup voice (Supertonic on the GPU is the main one): load it the first
// time it's actually needed, instead of holding ~1 GB and a load spike at every start.
let tts = null;
let ttsReady = null;
const ensureTts = () =>
  (ttsReady ??= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" })
    .then((m) => {
      tts = m;
      log("kokoro ready");
    })
    .catch((err) => {
      ttsReady = null;
      log("kokoro failed to load:", err?.message || err);
    }));

// One generation at a time: parallel ONNX runs just fight over the same cores.
let ttsChain = Promise.resolve();
function synth(text, voice, speed) {
  const run = ttsChain.then(async () => {
    await ensureTts();
    if (!tts) throw new Error("tts unavailable");
    const v = tts.voices[voice] ? voice : DEFAULT_VOICE;
    const audio = await tts.generate(text, { voice: v, speed });
    return Buffer.from(audio.toWav());
  });
  ttsChain = run.catch(() => {});
  return run;
}

// --- VAD (Silero v5: 512-sample windows at 16 kHz with 64 samples of context) -----------
const WINDOW = 512;
const CONTEXT = 64;
let vadSession = null;
// A tiny model run every 32 ms: one thread is plenty; the default (all cores) just burns CPU spinning.
const vadReady = ort.InferenceSession.create(VAD_MODEL, { intraOpNumThreads: 1, interOpNumThreads: 1 })
  .then((s) => {
    vadSession = s;
    log("silero vad ready");
  })
  .catch((err) => log("vad failed to load:", err?.message || err));

class VadStream {
  constructor(opts) {
    this.state = new Float32Array(2 * 1 * 128);
    this.context = new Float32Array(CONTEXT);
    this.pending = new Float32Array(0);
    this.speaking = false;
    this.speechRun = 0;
    this.silenceMs = 0;
    this.startThreshold = opts.startThreshold ?? 0.5;
    this.endThreshold = opts.endThreshold ?? 0.35;
    this.startFrames = opts.startFrames ?? 3; // ~96 ms of speech to start
    this.endSilenceMs = opts.endSilenceMs ?? 900;
    this.busy = Promise.resolve();
  }

  async prob(window) {
    const input = new Float32Array(CONTEXT + WINDOW);
    input.set(this.context, 0);
    input.set(window, CONTEXT);
    this.context = window.slice(WINDOW - CONTEXT);
    const out = await vadSession.run({
      input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
      state: new ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new ort.Tensor("int64", BigInt64Array.from([16000n]), []),
    });
    this.state = out.stateN.data;
    return out.output.data[0];
  }

  /** Feed PCM; calls emit() for speech-start / speech-end. */
  push(samples, emit) {
    this.busy = this.busy.then(async () => {
      if (!vadSession) return;
      const all = new Float32Array(this.pending.length + samples.length);
      all.set(this.pending, 0);
      all.set(samples, this.pending.length);
      let off = 0;
      for (; off + WINDOW <= all.length; off += WINDOW) {
        const p = await this.prob(all.subarray(off, off + WINDOW));
        const ms = (WINDOW / 16000) * 1000;
        if (!this.speaking) {
          this.speechRun = p >= this.startThreshold ? this.speechRun + 1 : 0;
          if (this.speechRun >= this.startFrames) {
            this.speaking = true;
            this.silenceMs = 0;
            emit({ type: "speech-start", p });
          }
        } else {
          this.silenceMs = p < this.endThreshold ? this.silenceMs + ms : 0;
          if (this.silenceMs >= this.endSilenceMs) {
            this.speaking = false;
            this.speechRun = 0;
            emit({ type: "speech-end", p });
          }
        }
      }
      this.pending = all.slice(off);
    });
  }
}

// --- HTTP / WS --------------------------------------------------------------------------
const authorized = (req, url) =>
  !TOKEN || req.headers["x-friday-voice-token"] === TOKEN || url.searchParams.get("token") === TOKEN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tts: true, ttsLoaded: Boolean(tts), vad: Boolean(vadSession) })); // tts loads on demand
    return;
  }
  if (!authorized(req, url)) {
    res.writeHead(401).end();
    return;
  }
  if (url.pathname === "/tts" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20_000) break;
    }
    try {
      const { text, voice, speed } = JSON.parse(body || "{}");
      if (typeof text !== "string" || !text.trim()) throw new Error("text required");
      const wav = await synth(text.slice(0, 2000), String(voice || DEFAULT_VOICE), Number(speed) || 1);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
      res.end(wav);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/vad" || !authorized(req, url)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const num = (k) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
    const stream = new VadStream({
      startThreshold: num("start"),
      endThreshold: num("end"),
      endSilenceMs: num("silenceMs"),
      startFrames: num("startFrames"),
    });
    const emit = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      stream.push(Float32Array.from(samples), emit);
    });
  });
});

await vadReady;
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}`));
