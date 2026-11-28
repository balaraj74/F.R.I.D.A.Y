// Microphone capture in the overlay: getUserMedia -> Float32 chunks -> 16 kHz mono WAV.
import {encodeWav16kMono} from '../lib/wav.mjs';

export const MAX_RECORD_MS = 30_000;

export class MicRecorder {
  constructor(onAutoStop) {
    this.onAutoStop = onAutoStop;
    this.chunks = [];
    this.active = false;
  }

  async start() {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    this.stream = stream;
    this.ctx = new AudioContext();
    this.chunks = [];
    const src = this.ctx.createMediaStreamSource(stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.onaudioprocess = (e) => this.chunks.push(Float32Array.from(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.active = true;
    this.timer = setTimeout(() => this.onAutoStop?.(), MAX_RECORD_MS);
  }

  /** @returns {Promise<Uint8Array|null>} the WAV bytes, or null when nothing was recorded */
  async stop() {
    if (!this.active) return null;
    this.active = false;
    clearTimeout(this.timer);
    const rate = this.ctx.sampleRate;
    this.node.disconnect();
    this.node.onaudioprocess = null;
    for (const t of this.stream.getTracks()) t.stop();
    await this.ctx.close().catch(() => {});
    const chunks = this.chunks;
    this.chunks = [];
    return chunks.length ? encodeWav16kMono(chunks, rate) : null;
  }
}
