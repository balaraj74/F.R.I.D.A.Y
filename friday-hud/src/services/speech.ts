// Advanced Human-Like Neural Voice & Voice Control Service for F.R.I.D.A.Y
import { SileroStream } from './silero-vad';
import { presence, readAnalyserLevel } from './presence';
import { cleanForSpeech, proseEnd, releaseSynth, SPOKEN_LEAD_MAX, speakableText, stripExpressionTags, takeSpeakableChunks, type Synth } from './speech-text';
import { gateway } from './gateway-ws';

export class SpeechService {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadAnimationId: number | null = null;
  private maxRecordTimer: number | null = null;
  private hasDetectedSpeech = false;
  /** Silero end-of-speech while listening (null = loudness fallback). */
  private listenVad: SileroStream | null = null;
  /** Silero speech detection while FRIDAY talks, for barge-in. */
  private bargeVad: SileroStream | null = null;

  private isListening = false;
  private isSpeaking = false;
  private isMuted = false;
  private audioPlayer: HTMLAudioElement | null = null;
  /** source 'offline' = the small on-device recogniser's guess; worth confirming before sending. */
  private onTranscriptCallback: ((text: string, isFinal: boolean, source?: 'cloud' | 'offline') => void) | null = null;
  private onListeningStateChange: ((listening: boolean) => void) | null = null;
  private onSpeakingStateChange: ((speaking: boolean) => void) | null = null;
  private listeningListeners = new Set<(listening: boolean) => void>();
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private onStatusCallback: ((status: string) => void) | null = null;
  private activeVoice = 'en-IE-EmilyNeural'; // Authentic Irish F.R.I.D.A.Y Voice

  constructor() {
    const savedMute = localStorage.getItem('friday_voice_muted');
    if (savedMute !== null) {
      this.isMuted = savedMute === 'true';
    }
  }

  public setVoice(voice: string) {
    this.activeVoice = voice;
  }

  public getVoice(): string {
    return this.activeVoice;
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    localStorage.setItem('friday_voice_muted', String(this.isMuted));
    if (this.isMuted) {
      this.stopSpeaking();
    }
    return this.isMuted;
  }

  public isVoiceMuted(): boolean {
    return this.isMuted;
  }

  public onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(cb);
    cb(this.isSpeaking);
    return () => this.speakingListeners.delete(cb);
  }

  public onListeningChange(cb: (listening: boolean) => void): () => void {
    this.listeningListeners.add(cb);
    cb(this.isListening);
    return () => this.listeningListeners.delete(cb);
  }

  private setSpeaking(speaking: boolean) {
    if (speaking === this.isSpeaking) return;
    this.isSpeaking = speaking;
    presence.setSpeaking(speaking);
    this.reportVoiceState();
    if (speaking) void this.startBargeInMonitor();
    else this.stopBargeInMonitor();
    this.onSpeakingStateChange?.(speaking);
    this.speakingListeners.forEach((cb) => {
      try { cb(speaking); } catch (e) { console.error(e); }
    });
  }

  private setListening(listening: boolean) {
    this.isListening = listening;
    presence.setListening(listening);
    if (!listening) presence.pushLevel(0);
    if (listening) this.localTranscript = { finals: [], partial: '' };
    this.reportVoiceState();
    this.onListeningStateChange?.(listening);
    this.listeningListeners.forEach((cb) => {
      try { cb(listening); } catch (e) { console.error(e); }
    });
  }

  /** Lets the wake-word sidecar follow along: transcribe while listening, pause while speaking. */
  private reportVoiceState() {
    window.electronAPI?.setVoiceState?.({ listening: this.isListening, speaking: this.isSpeaking });
  }

  // --- Offline transcript (Vosk sidecar) ------------------------------------------------
  // Shown live while you talk; used as the final text when cloud STT is unavailable.
  private localTranscript = { finals: [] as string[], partial: '' };

  public ingestLocalTranscript(kind: 'partial' | 'final', text: string) {
    if (!this.isListening) return;
    if (kind === 'final') {
      this.localTranscript.finals.push(text);
      this.localTranscript.partial = '';
    } else {
      this.localTranscript.partial = text;
    }
    this.onTranscriptCallback?.(this.localTranscriptText(), false);
  }

  private localTranscriptText(): string {
    return [...this.localTranscript.finals, this.localTranscript.partial].join(' ').replace(/\s+/g, ' ').trim();
  }

  // --- Barge-in: talking over FRIDAY interrupts her -------------------------------------
  // While she speaks, the mic runs with echo cancellation. Sustained voice that is clearly
  // louder than her own (echo-cancelled) playback counts as the user cutting in.
  private bargeInHandler: (() => void) | null = null;
  private bargeStream: MediaStream | null = null;
  private bargeCtx: AudioContext | null = null;
  private bargeRaf: number | null = null;
  private static readonly BARGE_LEVEL = 0.32;
  private static readonly BARGE_HOLD_MS = 320;

  public setBargeInHandler(cb: (() => void) | null) { this.bargeInHandler = cb; }

  public isBargeInEnabled(): boolean {
    try { return localStorage.getItem('friday_barge_in') !== 'false'; } catch { return true; }
  }

  public setBargeInEnabled(on: boolean) {
    try { localStorage.setItem('friday_barge_in', String(on)); } catch {}
    if (!on) this.stopBargeInMonitor();
  }

  private async startBargeInMonitor() {
    if (!this.bargeInHandler || !this.isBargeInEnabled() || this.bargeStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // AGC off so residual echo isn't amplified into a false trigger.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      if (!this.isSpeaking) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.bargeStream = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.bargeCtx = new AudioCtx();
      const analyser = this.bargeCtx.createAnalyser();
      analyser.fftSize = 512;
      this.bargeCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      // Strict Silero settings: only real speech, sustained ~200 ms, can interrupt her.
      void SileroStream.open(stream, { start: 0.75, startFrames: 6, silenceMs: 400 }).then((vad) => {
        if (vad && this.bargeStream === stream) this.bargeVad = vad;
        else vad?.close();
      });
      let voicedSince = 0;
      const tick = (now: number) => {
        if (!this.bargeStream) return;
        const mic = readAnalyserLevel(analyser, buf);
        // With Silero: it must hear speech AND the mic must be louder than her own playback
        // (echo). Without it: the loudness rule alone.
        const speech = this.bargeVad?.connected ? this.bargeVad.speaking : mic > SpeechService.BARGE_LEVEL;
        const voiced = speech && mic > presence.level * 0.9;
        voicedSince = voiced ? voicedSince || now : 0;
        if (voicedSince && now - voicedSince > SpeechService.BARGE_HOLD_MS) {
          this.stopBargeInMonitor();
          this.bargeInHandler?.();
          return;
        }
        this.bargeRaf = requestAnimationFrame(tick);
      };
      this.bargeRaf = requestAnimationFrame(tick);
    } catch (e) {
      console.warn('Barge-in monitor unavailable:', e);
    }
  }

  private stopBargeInMonitor() {
    this.bargeVad?.close();
    this.bargeVad = null;
    if (this.bargeRaf) cancelAnimationFrame(this.bargeRaf);
    this.bargeRaf = null;
    this.bargeStream?.getTracks().forEach((t) => t.stop());
    this.bargeStream = null;
    if (this.bargeCtx && this.bargeCtx.state !== 'closed') void this.bargeCtx.close();
    this.bargeCtx = null;
  }

  public getIsSpeaking(): boolean {
    return this.isSpeaking;
  }

  public getIsListening(): boolean {
    return this.isListening;
  }

  // --- Speech-to-Text Voice Recording with VAD & Gemini 2.5 Flash ---

  public async startListening(
    onTranscript: (text: string, isFinal: boolean, source?: 'cloud' | 'offline') => void,
    onStateChange: (listening: boolean) => void,
    onStatus?: (status: string) => void
  ): Promise<void> {
    if (this.isListening) return;

    this.onTranscriptCallback = onTranscript;
    this.onListeningStateChange = onStateChange;
    this.onStatusCallback = onStatus || null;

    this.stopSpeaking(); // Immediately stop AI speech when user engages mic

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone audio API not supported in this environment');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mediaStream = stream;
      this.audioChunks = [];
      this.hasDetectedSpeech = false;
      this.setListening(true);
      onStatus?.('Listening to your voice...');

      // Determine best audio recording format supported by Chromium/Electron
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';
        }
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      this.mediaRecorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        onStatus?.('Transcribing speech...');
        await this.processRecordedAudio();
      };

      recorder.start(250); // Emit audio data every 250ms

      // Setup Web Audio VAD (Voice Activity Detection)
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
          const source = this.audioContext.createMediaStreamSource(stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 512;
          source.connect(this.analyser);
          this.startVadMonitor(onStatus);
        }
      } catch (err) {
        console.warn('AudioContext VAD initialization error:', err);
      }

      // Silero VAD decides when Sir has finished (pauses mid-sentence don't end the turn).
      void SileroStream.open(stream, {
        silenceMs: 650,
        onSpeechStart: () => {
          if (!this.hasDetectedSpeech) onStatus?.('Hearing you speak...');
          this.hasDetectedSpeech = true;
        },
        onSpeechEnd: () => {
          if (!this.isListening) return;
          this.stopListening();
          this.playFiller(); // instantly, like someone listening
        },
      }).then((vad) => {
        if (vad && this.isListening && this.mediaStream === stream) this.listenVad = vad;
        else vad?.close();
      });

      // Safety timeout: max 30 seconds of recording
      this.maxRecordTimer = window.setTimeout(() => {
        if (this.isListening) {
          this.stopListening();
        }
      }, 30000);
    } catch (err: any) {
      console.error('Failed to access microphone stream:', err);
      this.cleanupRecording();
      this.setListening(false);
      onStatus?.(err?.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone error');
    }
  }

  private startVadMonitor(onStatus?: (status: string) => void) {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const waveArray = new Uint8Array(this.analyser.fftSize);
    let silenceStartTime = 0;

    const checkVolume = () => {
      if (!this.isListening || !this.analyser) return;

      presence.pushLevel(readAnalyserLevel(this.analyser, waveArray));
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;

      // Detect human speech threshold (average volume > 10)
      if (average > 10 && !this.listenVad?.connected) {
        if (!this.hasDetectedSpeech) {
          this.hasDetectedSpeech = true;
          onStatus?.('Hearing you speak...');
        }
        silenceStartTime = 0;
      } else if (this.hasDetectedSpeech) {
        if (silenceStartTime === 0) {
          silenceStartTime = Date.now();
        } else if (!this.listenVad?.connected && Date.now() - silenceStartTime > 1600) {
          // 1.6s of silence after speech detected -> auto stop and process!
          console.log('[VAD] Speech completed, submitting voice command.');
          this.stopListening();
          return;
        }
      }

      this.vadAnimationId = requestAnimationFrame(checkVolume);
    };

    this.vadAnimationId = requestAnimationFrame(checkVolume);
  }

  public stopListening() {
    if (!this.isListening) return;
    this.setListening(false);

    if (this.vadAnimationId) {
      cancelAnimationFrame(this.vadAnimationId);
      this.vadAnimationId = null;
    }
    if (this.maxRecordTimer) {
      clearTimeout(this.maxRecordTimer);
      this.maxRecordTimer = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else {
      this.cleanupRecording();
    }
  }

  public toggleListening(
    onTranscript: (text: string, isFinal: boolean, source?: 'cloud' | 'offline') => void,
    onStateChange: (listening: boolean) => void,
    onStatus?: (status: string) => void
  ) {
    if (this.isListening) {
      this.stopListening();
    } else {
      this.startListening(onTranscript, onStateChange, onStatus);
    }
  }

  private async processRecordedAudio() {
    if (this.audioChunks.length === 0) {
      this.cleanupRecording();
      return;
    }

    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const audioBlob = new Blob(this.audioChunks, { type: mimeType });
    this.cleanupRecording();

    if (audioBlob.size < 1200) {
      // Audio buffer is too small (< 1.2KB), likely an instant accidental tap
      return;
    }

    try {
      // Convert Blob to Base64
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });

      if (window.electronAPI?.transcribeAudio) {
        const res = await window.electronAPI.transcribeAudio(base64Data, mimeType);
        if (res && res.success && res.text && res.text.trim()) {
          this.onTranscriptCallback?.(res.text.trim(), true, 'cloud');
          return;
        }
        // Local Whisper heard no speech: don't substitute the offline recogniser's guess.
        if (res?.success && res.heardNothing) {
          this.onStatusCallback?.("Didn't catch that");
          return;
        }
        if (res?.error !== 'no-gemini-key') console.warn('[STT] Cloud transcription failed:', res?.error);
      }
    } catch (err) {
      console.error('[STT] Error converting/transcribing voice audio:', err);
    }
    // Cloud STT unavailable or failed: use what the offline recognizer heard.
    const local = this.localTranscriptText();
    if (local) this.onTranscriptCallback?.(local, true, 'offline');
  }

  private cleanupRecording() {
    this.listenVad?.close();
    this.listenVad = null;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    this.analyser = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  public stopSpeaking() {
    // Invalidate the queue and any synthesis still in flight, and stay quiet for the rest of
    // this reply (an interrupted turn still delivers its final/aborted text afterwards).
    this.streamGen++;
    this.streamSuppressed = true;
    this.queue.forEach((item) => item.synth?.then(releaseSynth));
    this.queue = [];
    this.streamConsumed = 0;
    this.streamText = '';
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.currentTime = 0;
      this.audioPlayer = null;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.setSpeaking(false);
  }

  // --- Streaming speech ---------------------------------------------------------------
  // FRIDAY starts talking as soon as the first sentence of a reply exists, while the rest
  // is still being generated. The next sentence is synthesized while the current one plays.

  private queue: { text: string; synth?: Promise<Synth> }[] = [];
  private streamGen = 0;          // bumps on stop; stale async work checks it and bails
  private streamText = '';        // speakable text of the current reply consumed so far
  private streamConsumed = 0;     // chars of streamText already queued
  private streamDone = true;      // the current reply finished; next text starts a new one
  private streamSuppressed = false; // the user stopped/interrupted this reply: don't resume it
  private pumping = false;
  private idleTimer: number | null = null;

  /** Start a fresh reply (e.g. the user just sent a message). */
  public beginStream() {
    this.stopSpeaking();
    this.streamSuppressed = false;
    this.streamDone = false;
  }

  /** Feed the cumulative reply text as it streams in; `done` marks the final chunk. */
  public feedStream(fullText: string, done: boolean) {
    if (this.isMuted) return;
    const speakable = speakableText(fullText, done);
    // A reply that doesn't extend what we've consumed is a new message (unsolicited reply, new turn).
    if (this.streamDone || !speakable.startsWith(this.streamText.slice(0, this.streamConsumed))) {
      this.streamConsumed = 0;
      this.streamSuppressed = false;
      this.summaryAsked = false;
    }
    this.streamText = speakable;
    this.streamFull = fullText;
    this.streamDone = done;
    if (this.streamSuppressed) return;

    // Speak the conversational opening as it streams; stop where the report part begins.
    const cut = proseEnd(speakable);
    const lead = cut >= 0 ? speakable.slice(0, cut) : speakable;
    const capped = this.streamConsumed >= SPOKEN_LEAD_MAX;
    if (!capped) {
      const { chunks, consumed } = takeSpeakableChunks(
        lead.slice(this.streamConsumed),
        done || cut >= 0,
        this.streamConsumed > 0,
      );
      this.streamConsumed += consumed;
      for (const chunk of chunks) {
        const clean = cleanForSpeech(chunk);
        if (clean) this.queue.push({ text: clean });
      }
    }
    const heldBack = speakable.slice(this.streamConsumed).trim();
    if (done && heldBack && !this.summaryAsked) {
      this.summaryAsked = true;
      void this.speakSummary(fullText, speakable.slice(0, this.streamConsumed));
    }
    void this.pump();
  }

  private summaryAsked = false;

  /** The part of a reply she didn't read out, said the way a person would (details stay on screen). */
  private async speakSummary(fullText: string, alreadySaid: string) {
    const gen = this.streamGen;
    const res = await gateway
      .request<{ spoken?: string }>('brain.spoken', { text: fullText, alreadySaid })
      .catch(() => null);
    if (gen !== this.streamGen || this.isMuted) return;
    const spoken = cleanForSpeech(typeof res?.spoken === 'string' ? res.spoken : '');
    const line = spoken || (alreadySaid.trim() ? '' : "It's all on your screen, Sir.");
    if (!line) return;
    this.queue.push({ text: line });
    void this.pump();
  }

  private streamFull = '';

  /** The reply finished without a final text chunk: flush whatever tail is left. */
  public endStream() {
    if (!this.streamDone) this.feedStream(this.streamFull, true);
  }

  /** Speak a complete text (greetings, one-off lines). */
  /**
   * A short spoken progress line while FRIDAY works ("Searching for …"). Queued like any other
   * sentence, but it doesn't start, end or reset the current reply stream.
   */
  public sayInterim(text: string) {
    if (this.isMuted || this.isListening) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    this.queue.push({ text: clean });
    void this.pump();
  }

  // Pre-recorded short listening sounds in FRIDAY's own voice: no synthesis, so no delay.
  private fillers: string[] = [];
  private lastFiller = -1;

  /** Call once the voice is ready. Safe to call again. */
  public async prepareFillers() {
    if (this.fillers.length || !window.electronAPI?.synthesizeSpeech) return;
    for (const line of ['Mm-hmm.', 'Okay.', 'Right.', 'Mm, okay.', 'Sure.']) {
      try {
        const res = await window.electronAPI.synthesizeSpeech(line, this.activeVoice);
        if (!res?.success || res.engine !== 'local' || !res.audioBase64) continue;
        const bytes = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
        this.fillers.push(URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'audio/wav' })));
      } catch {
        return; // no local voice: no fillers
      }
    }
  }

  private playFiller() {
    if (this.isMuted || !this.fillers.length) return;
    let i = Math.floor(Math.random() * this.fillers.length);
    if (i === this.lastFiller) i = (i + 1) % this.fillers.length;
    this.lastFiller = i;
    new Audio(this.fillers[i]).play().catch(() => {});
  }

  public async speak(text: string): Promise<void> {
    if (this.isMuted || !text || !text.trim()) return;
    this.beginStream();
    this.feedStream(text, true);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.streamGen;
    try {
      while (this.queue.length > 0 && gen === this.streamGen) {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (!this.isSpeaking) this.setSpeaking(true);
        // Keep at most two syntheses in flight: the one about to play and the next.
        for (const item of this.queue.slice(0, 2)) item.synth ??= this.synthesize(item.text);
        const item = this.queue[0];
        const synth = await item.synth!;
        if (gen !== this.streamGen) { releaseSynth(synth); return; }
        await this.playSynth(synth, item.text);
        this.queue.shift();
      }
    } finally {
      this.pumping = false;
    }
    if (gen !== this.streamGen) return;
    // Between sentences of a reply that's still streaming, hold "speaking" briefly so the
    // HUD doesn't flicker; once the reply is done, release immediately.
    if (this.streamDone) this.setSpeaking(false);
    else this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.queue.length === 0) this.setSpeaking(false);
    }, 600);
  }

  private async synthesize(text: string): Promise<Synth> {
    if (window.electronAPI?.synthesizeSpeech) {
      try {
        const res = await window.electronAPI.synthesizeSpeech(text, this.activeVoice);
        if (res?.success && res.audioBase64) {
          // Same-origin blob: playable through Web Audio, so the reactor can follow the real voice.
          const bytes = Uint8Array.from(atob(res.audioBase64), (c) => c.charCodeAt(0));
          return { kind: 'blob', url: URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'audio/mpeg' })) };
        }
        if (res?.success && res.audioUrl) return { kind: 'file', url: res.audioUrl };
      } catch (err) {
        console.warn('Neural TTS synthesis failed, falling back to Web Speech:', err);
      }
    }
    return { kind: 'browser' };
  }

  private async playSynth(synth: Synth, text: string) {
    if (/<laugh>/i.test(text)) presence.emote('laugh');
    if (/<sigh>/i.test(text)) presence.emote('sigh');
    if (synth.kind === 'browser') return this.speakBrowserFallback(text);
    try {
      await this.playAudioUrl(synth.url, synth.kind === 'blob');
    } finally {
      releaseSynth(synth);
    }
  }

  // Routes TTS playback through an analyser so the reactor moves with FRIDAY's actual voice.
  private ttsContext: AudioContext | null = null;

  /** Synthetic level for voices we can't analyse, so the reactor still visibly speaks. */
  private swaying = false;

  private swayWhileSpeaking() {
    if (this.swaying) return;
    this.swaying = true;
    const sway = () => {
      if (!this.isSpeaking) { this.swaying = false; return; }
      presence.pushLevel(0.25 + 0.15 * Math.sin(performance.now() / 90));
      requestAnimationFrame(sway);
    };
    requestAnimationFrame(sway);
  }

  private trackPlaybackLevel(audio: HTMLAudioElement) {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.ttsContext ??= new AudioCtx();
      const ctx = this.ttsContext;
      if (ctx.state === 'suspended') void ctx.resume();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (this.audioPlayer !== audio) { source.disconnect(); analyser.disconnect(); return; }
        presence.pushLevel(readAnalyserLevel(analyser, buf));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch (e) {
      console.warn('TTS level tracking unavailable:', e);
    }
  }

  private playAudioUrl(url: string, analysable: boolean): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      this.audioPlayer = audio;
      audio.volume = 1.0;
      // Only route same-origin audio through Web Audio; cross-origin media would play silent.
      if (analysable) this.trackPlaybackLevel(audio);
      else this.swayWhileSpeaking();

      // The speaking state is owned by the queue (pump), not by individual sentences.
      const finish = () => {
        if (this.audioPlayer === audio) this.audioPlayer = null;
        resolve();
      };
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(finish);
    });
  }

  private speakBrowserFallback(rawText: string): Promise<void> {
    const text = stripExpressionTags(rawText);
    return new Promise((resolve) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find((v) => v.name.includes('Irish') || v.lang === 'en-IE') ||
        voices.find((v) => v.name.includes('Natural') || v.name.includes('Female')) ||
        voices.find((v) => v.lang === 'en-US' || v.lang === 'en-GB');

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      // Browser TTS exposes no audio stream; approximate the voice from word boundaries.
      utterance.onboundary = () => presence.pushLevel(0.9);
      this.swayWhileSpeaking();

      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      window.speechSynthesis.speak(utterance);
    } else {
      resolve();
    }
    });
  }

  // Generate dynamic personalized cinematic greeting based on local time
  public getCinematicGreeting(userName = 'Boss'): string {
    const hour = new Date().getHours();
    // Only say things that are true at this moment: no model names, weather or counts that weren't checked.
    if (hour >= 5 && hour < 12) {
      return `Good morning ${userName}. I'm online and listening.`;
    } else if (hour >= 12 && hour < 17) {
      return `Good afternoon ${userName}. I'm online. What are we working on?`;
    } else if (hour >= 17 && hour < 22) {
      return `Good evening ${userName}. Gateway's up. Ready when you are.`;
    } else {
      return `Still up, ${userName}? I'm here. Keep it short or keep it going, your call.`;
    }
  }
}

export const speechService = new SpeechService();
