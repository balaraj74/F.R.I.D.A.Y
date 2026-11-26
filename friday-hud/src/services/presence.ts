// FRIDAY presence: a single source of truth for what FRIDAY is doing right now.
// Discrete mode changes notify React subscribers; continuous signals (audio level,
// tool pulses) are read directly by animation loops so they never trigger re-renders.

import type { ActivityStep } from '../types';

export type Emote = 'laugh' | 'sigh' | 'wave';
export type PresenceMode = 'idle' | 'listening' | 'thinking' | 'acting' | 'speaking' | 'approval';

/** FRIDAY's computed affect vector, as emitted by the runner (not decoration). */
export interface Affect {
  valence: number; // -1..1
  arousal: number; // 0..1
  curiosity: number; // 0..1
  caution: number; // 0..1
}

export const NEUTRAL_AFFECT: Affect = { valence: 0, arousal: 0.3, curiosity: 0.5, caution: 0.3 };

/** Short words for the clearly-non-neutral parts of the state; empty when neutral. */
export function moodWords(a: Affect): string[] {
  const words: string[] = [];
  if (a.valence <= -0.4) words.push('frustrated');
  else if (a.valence >= 0.5) words.push('pleased');
  if (a.arousal >= 0.7) words.push('energised');
  else if (a.arousal <= 0.15) words.push('calm');
  if (a.curiosity >= 0.65) words.push('curious');
  if (a.caution >= 0.6) words.push('cautious');
  return words;
}

export interface PresenceSnapshot {
  mode: PresenceMode;
  /** Name of the most recent running tool, when mode === 'acting'. */
  activeTool: string | null;
}

class PresenceStore {
  private listening = false;
  private thinking = false;
  private speaking = false;
  private awaitingApproval = false;
  private runningTools: string[] = [];
  private seenRunning = new Set<string>();
  private snapshot: PresenceSnapshot = { mode: 'idle', activeTool: null };
  private listeners = new Set<(s: PresenceSnapshot) => void>();

  /** Smoothed 0..1 loudness of whoever is talking (mic while listening, TTS while speaking). */
  level = 0;
  /** performance.now() of the last tool start; animation renders a ripple from it. */
  lastPulseAt = -Infinity;
  /** Latest computed affect from the runner; read by the reactor every frame. */
  affect: Affect = { ...NEUTRAL_AFFECT };
  private affectListeners = new Set<(a: Affect) => void>();

  setAffect(a: Partial<Affect>) {
    const clamp = (v: unknown, lo: number, hi: number, d: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    this.affect = {
      valence: clamp(a.valence, -1, 1, this.affect.valence),
      arousal: clamp(a.arousal, 0, 1, this.affect.arousal),
      curiosity: clamp(a.curiosity, 0, 1, this.affect.curiosity),
      caution: clamp(a.caution, 0, 1, this.affect.caution),
    };
    this.affectListeners.forEach((cb) => cb(this.affect));
  }

  onAffect(cb: (a: Affect) => void): () => void {
    this.affectListeners.add(cb);
    cb(this.affect);
    return () => this.affectListeners.delete(cb);
  }

  setListening(v: boolean) { this.listening = v; this.recompute(); }
  setThinking(v: boolean) { this.thinking = v; this.recompute(); }
  setSpeaking(v: boolean) { this.speaking = v; if (!v) this.level = 0; this.recompute(); }
  setAwaitingApproval(v: boolean) { this.awaitingApproval = v; this.recompute(); }

  /** Feed a raw 0..1 level; attack fast, release slow so the visual feels like a voice, not a meter. */
  pushLevel(raw: number) {
    const v = Math.max(0, Math.min(1, raw));
    this.level += (v - this.level) * (v > this.level ? 0.45 : 0.12);
  }

  pulse() { this.lastPulseAt = performance.now(); }

  // One-off moments from her speech (<laugh>, <sigh>), acted out by the avatar.
  private emoteListeners = new Set<(kind: Emote) => void>();
  emote(kind: Emote) { this.emoteListeners.forEach((cb) => cb(kind)); }
  onEmote(cb: (kind: Emote) => void): () => void {
    this.emoteListeners.add(cb);
    return () => this.emoteListeners.delete(cb);
  }

  setActivities(all: ActivityStep[]) {
    const running = all.filter((a) => a.type === 'action' && a.status === 'running' && a.toolCall);
    for (const a of running) {
      if (!this.seenRunning.has(a.id)) {
        this.seenRunning.add(a.id);
        this.pulse();
      }
    }
    if (all.length === 0) this.seenRunning.clear();
    this.runningTools = running.map((a) => a.toolCall!.name);
    this.recompute();
  }

  get(): PresenceSnapshot { return this.snapshot; }

  subscribe(cb: (s: PresenceSnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshot);
    return () => this.listeners.delete(cb);
  }

  private recompute() {
    // Priority: what the user perceives most strongly wins.
    const mode: PresenceMode = this.awaitingApproval
      ? 'approval'
      : this.speaking
      ? 'speaking'
      : this.listening
      ? 'listening'
      : this.runningTools.length > 0
      ? 'acting'
      : this.thinking
      ? 'thinking'
      : 'idle';
    const activeTool = mode === 'acting' ? this.runningTools[this.runningTools.length - 1] ?? null : null;
    if (mode === this.snapshot.mode && activeTool === this.snapshot.activeTool) return;
    this.snapshot = { mode, activeTool };
    this.listeners.forEach((cb) => {
      try { cb(this.snapshot); } catch (e) { console.error(e); }
    });
  }
}

export const presence = new PresenceStore();

// Dev-only handle for driving states from the console while tuning the animation.
if (import.meta.env.DEV) (window as unknown as { __presence: PresenceStore }).__presence = presence;

/** Average loudness of an analyser's time-domain signal, normalised to roughly 0..1. */
export function readAnalyserLevel(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = (buf[i] - 128) / 128;
    sum += d * d;
  }
  // RMS of speech sits around 0.02–0.2; map that range onto 0..1.
  return Math.min(1, Math.sqrt(sum / buf.length) * 6);
}
