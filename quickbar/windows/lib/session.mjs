// The quick bar's conversation, as the Linux daemon does it (quickbar/daemon/daemon.mjs onSummon,
// onAsk, onMic) but with every collaborator injected so it runs under test.
//
// emit() sends the same events the Linux daemon sends to the extension:
//   status {text}, delta {text}, final {text}, error {message}, mic {state}, transcript {text}, speaking {on}
import {buildAskRequest} from './message.mjs';

export class QuickSession {
  /**
   * @param {object} d
   * @param {{chat:Function, abort:Function, connect:Function, connected?:boolean}} d.gateway
   * @param {(status:(t:string)=>void)=>Promise<{ok:boolean,error?:string}>} d.ensureGateway
   * @param {()=>Promise<string|null>} d.ensureStt base URL of speech to text, or null
   * @param {(base:string, wav:Uint8Array)=>Promise<string>} d.transcribe
   * @param {{say:(text:string)=>Promise<boolean>, stop:()=>void}} d.speaker
   * @param {(event:object)=>void} d.emit
   * @param {{pickSpoken:Function, leadParagraphIfComplete:Function}} d.speech
   * @param {() => boolean} d.speakEnabled
   */
  constructor(d) {
    Object.assign(this, d);
    this.state = {shot: null, shotSent: false, runId: null, spoke: false};
  }

  /** `shot` is a promise of {base64, mimeType} or null, started before the bar was shown. */
  summon({shot = null} = {}) {
    this.state = {shot: Promise.resolve(shot).catch(() => null), shotSent: false, runId: null, spoke: false};
    this.speaker.stop();
    // Warm the engine while the user is still typing; failures are not errors yet.
    this.ensureGateway((text) => this.emit({ev: 'status', text}))
      .then((r) => {
        if (!r.ok) this.emit({ev: 'status', text: r.error});
        else this.gateway.connect().catch(() => {});
      })
      .catch(() => {});
  }

  async ask(rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) return;
    this.speaker.stop();
    if (this.state.runId) await this.gateway.abort(this._key(), this.state.runId);
    this.state.spoke = false;
    const up = await this.ensureGateway((t) => this.emit({ev: 'status', text: t}));
    if (!up.ok) return this.emit({ev: 'error', message: up.error});
    const image = this.state.shotSent ? null : await this.state.shot;
    const req = buildAskRequest({text, image});
    this.emit({ev: 'status', text: 'Thinking...'});
    try {
      this.state.runId = await this.gateway.chat({
        ...req,
        onDelta: (answer) => {
          this.emit({ev: 'delta', text: answer});
          if (this.speakEnabled() && !this.state.spoke) {
            const lead = this.speech.leadParagraphIfComplete(answer);
            if (lead) this._speak(lead);
          }
        },
        onFinal: (answer) => {
          this.state.runId = null;
          this.emit({ev: 'final', text: answer});
          if (this.speakEnabled() && !this.state.spoke) {
            const lead = this.speech.pickSpoken(answer);
            if (lead) this._speak(lead);
          }
        },
        onError: (message) => {
          this.state.runId = null;
          this.emit({ev: 'error', message});
        },
      });
      if (image) this.state.shotSent = true;
    } catch (err) {
      this.emit({ev: 'error', message: String(err?.message ?? err)});
    }
  }

  _key() {
    return buildAskRequest({text: ''}).sessionKey;
  }

  _speak(text) {
    this.state.spoke = true;
    this.emit({ev: 'speaking', on: true});
    this.speaker
      .say(text)
      .catch(() => {})
      .finally(() => this.emit({ev: 'speaking', on: false}));
  }

  /** The renderer finished recording: transcribe the WAV and hand the text back. */
  async audio(wav) {
    this.emit({ev: 'mic', state: 'idle'});
    if (!wav || wav.length <= 1600) return this.emit({ev: 'transcript', text: ''});
    try {
      this.emit({ev: 'status', text: 'Listening...'});
      const base = await this.ensureStt();
      if (!base) throw new Error('Voice input is off: speech recognition is not running. You can still type.');
      this.emit({ev: 'transcript', text: await this.transcribe(base, wav)});
    } catch (err) {
      this.emit({ev: 'error', message: String(err?.message ?? err)});
    }
  }

  micStarted() {
    this.speaker.stop();
    this.ensureStt().catch(() => {});
  }

  silence() {
    this.speaker.stop();
  }

  async abort() {
    this.speaker.stop();
    if (this.state.runId) await this.gateway.abort(this._key(), this.state.runId);
  }

  dismiss() {
    this.speaker.stop();
    return this.abort();
  }
}
