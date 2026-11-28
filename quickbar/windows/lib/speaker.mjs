// One spoken answer at a time; a new request or stop() cuts the current one off.
// Same contract as Speaker in quickbar/daemon/voice.mjs, but the audio is produced by `synthesize`
// and played by `play` (the overlay's <audio> element) instead of a child process.
export class Speaker {
  /**
   * @param {{synthesize:(text:string)=>Promise<object|null>, play:(audio:object)=>Promise<boolean>, stopPlayback:()=>void}} io
   */
  constructor(io) {
    this.io = io;
    this.generation = 0;
    this.playing = false;
  }

  stop() {
    this.generation++;
    if (this.playing) {
      this.playing = false;
      this.io.stopPlayback();
    }
  }

  /** Resolves true when the whole text was played. */
  async say(text) {
    if (!text) return false;
    this.stop();
    const mine = this.generation;
    const audio = await this.io.synthesize(text).catch(() => null);
    if (!audio || mine !== this.generation) return false;
    this.playing = true;
    const ok = await this.io.play(audio).catch(() => false);
    if (mine === this.generation) this.playing = false;
    return ok && mine === this.generation;
  }
}
