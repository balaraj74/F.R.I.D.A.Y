// Streams microphone audio (16 kHz mono) to the local voice server's Silero VAD and reports
// when real speech starts and ends. Much more reliable than a loudness threshold: background
// noise and a fan don't count as speech, and short pauses mid-sentence don't end the turn.
// If the local voice server isn't running, open() returns null and callers keep their
// loudness-based fallback.

export interface SileroOptions {
  /** Silence after speech that ends the utterance (ms). */
  silenceMs?: number;
  /** Probability needed to start speech (higher = stricter, used for barge-in). */
  start?: number;
  /** Consecutive 32 ms windows above `start` before speech counts. */
  startFrames?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

// Collects 16 kHz Float32 samples and posts them in ~128 ms chunks.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
`;

let workletUrl: string | null = null;

export class SileroStream {
  private constructor(
    private ws: WebSocket,
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    private source: MediaStreamAudioSourceNode,
  ) {}

  speaking = false;

  static async open(stream: MediaStream, opts: SileroOptions = {}): Promise<SileroStream | null> {
    let endpoint: { vadUrl: string | null } | undefined;
    try {
      endpoint = await window.electronAPI?.getVoiceEndpoint?.();
    } catch {
      return null;
    }
    if (!endpoint?.vadUrl) return null;

    const url = new URL(endpoint.vadUrl);
    if (opts.silenceMs) url.searchParams.set('silenceMs', String(opts.silenceMs));
    if (opts.start) url.searchParams.set('start', String(opts.start));
    if (opts.startFrames) url.searchParams.set('startFrames', String(opts.startFrames));

    const ws = new WebSocket(url.toString());
    ws.binaryType = 'arraybuffer';
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 1500);
    });
    if (!opened) {
      ws.close();
      return null;
    }

    // The browser resamples the mic to the context rate, so Silero gets the 16 kHz it expects.
    const ctx = new AudioContext({ sampleRate: 16000 });
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-tap');
    source.connect(node);
    // Pulled by the destination so it keeps running; it outputs silence.
    node.connect(ctx.destination);
    const vad = new SileroStream(ws, ctx, node, source);

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer);
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'speech-start') {
          vad.speaking = true;
          opts.onSpeechStart?.();
        } else if (msg.type === 'speech-end') {
          vad.speaking = false;
          opts.onSpeechEnd?.();
        }
      } catch {}
    };
    return vad;
  }

  get connected(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    try { this.source.disconnect(); } catch {}
    try { this.node.disconnect(); } catch {}
    this.node.port.onmessage = null;
    if (this.ctx.state !== 'closed') void this.ctx.close();
    this.ws.close();
  }
}
