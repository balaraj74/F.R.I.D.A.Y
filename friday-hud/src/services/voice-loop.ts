// One controller for every way a voice turn starts or stops:
// wake word, global push-to-talk (Ctrl+Alt+Space), the mic button, and barge-in.

import { fastBrain } from './fast-brain';
import { speechService } from './speech';
import type { VoiceCommand } from '../types';

export interface VoiceLoopView {
  listening: boolean;
  /** What we've heard so far (live, then final). */
  transcript: string;
  status: string;
  /** Offline-recognised text waiting for Sir to confirm (put in the input box, not sent). */
  draft: string;
}

interface Hooks {
  /** Submit a finished utterance as a chat message. */
  send: (text: string) => void;
  /** True while FRIDAY is still generating or running tools for the current turn. */
  isBusy: () => boolean;
  /** Cancel the in-flight turn on the gateway. */
  abort: () => void;
}

class VoiceLoop {
  private hooks: Hooks | null = null;
  private view: VoiceLoopView = { listening: false, transcript: '', status: '', draft: '' };
  private listeners = new Set<(v: VoiceLoopView) => void>();
  private unsubCommands: (() => void) | null = null;

  /** Called once by App with the chat hooks; returns a cleanup function. */
  attach(hooks: Hooks): () => void {
    this.hooks = hooks;
    this.unsubCommands = window.electronAPI?.onVoiceCommand?.((cmd) => this.handle(cmd)) ?? null;
    speechService.setBargeInHandler(() => {
      // She was talking and you cut in: stop her, cancel the turn, and listen.
      this.startTurn('Go ahead…');
    });
    return () => {
      this.unsubCommands?.();
      speechService.setBargeInHandler(null);
      this.hooks = null;
    };
  }

  subscribe(cb: (v: VoiceLoopView) => void): () => void {
    this.listeners.add(cb);
    cb(this.view);
    return () => this.listeners.delete(cb);
  }

  /** Mic button / push-to-talk: start a turn, or finish the one in progress. */
  toggle() {
    if (speechService.getIsListening()) speechService.stopListening();
    else this.startTurn();
  }

  /** Stop FRIDAY talking and cancel whatever she's doing for the current turn. */
  interrupt() {
    if (speechService.getIsSpeaking()) speechService.stopSpeaking();
    if (this.hooks?.isBusy()) this.hooks.abort();
  }

  private handle(cmd: VoiceCommand) {
    switch (cmd.type) {
      case 'wake':
        if (!speechService.getIsListening()) this.startTurn('Yes, Sir?');
        break;
      case 'ptt':
        this.toggle();
        break;
      case 'cancel':
        if (speechService.getIsListening()) speechService.stopListening();
        this.interrupt();
        break;
      case 'partial':
      case 'final':
        speechService.ingestLocalTranscript(cmd.type, cmd.text);
        break;
    }
  }

  /** CommandBar took the draft into its input box. */
  consumeDraft() {
    if (this.view.draft) this.update({ draft: '' });
  }

  private startTurn(prompt = 'Listening…') {
    this.interrupt();
    playCue();
    this.update({ transcript: '', status: prompt, draft: '' });
    void speechService.startListening(
      (text, isFinal, source) => {
        this.update({ transcript: text });
        if (!isFinal) {
          fastBrain.prefetch(text); // get her acknowledgement ready while Sir is still talking
          return;
        }
        if (!text.trim()) return;
        if (source === 'offline') {
          // The on-device recogniser often mishears; let Sir confirm instead of sending a guess.
          this.update({ transcript: '', draft: text.trim(), status: 'Heard offline: check it, then press Enter' });
          return;
        }
        this.hooks?.send(text.trim());
        this.update({ transcript: '', status: '' });
      },
      (listening) => {
        this.update({ listening });
        if (!listening) setTimeout(() => !speechService.getIsListening() && this.update({ status: '' }), 2500);
      },
      (status) => this.update({ status }),
    );
  }

  private update(patch: Partial<VoiceLoopView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((cb) => cb(this.view));
  }
}

// Short, soft rising chime so you know FRIDAY is listening (wake word / push-to-talk).
let cueCtx: AudioContext | null = null;
function playCue() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    cueCtx ??= new AudioCtx();
    const ctx = cueCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.exponentialRampToValueAtTime(990, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  } catch {
    // the cue is optional
  }
}

export const voiceLoop = new VoiceLoop();
