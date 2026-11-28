// Feeds pointer samples to the Shake_Detector (quickbar/extension/shake.js, used unchanged).
// Electron has no pointer-motion event outside its own windows, so the host polls the cursor.
// Like the Linux extension, a sample is only fed when the pointer actually moved.

export const POLL_MS = 16;

export class ShakeFeed {
  /**
   * @param {object} o
   * @param {{getCursorScreenPoint: () => {x:number,y:number}}} o.screen Electron `screen` (injected)
   * @param {() => number} o.now monotonic clock in ms (injected)
   * @param {{push: (x:number,y:number,t:number)=>boolean, reset: ()=>void}} o.detector
   * @param {() => void} o.onShake
   * @param {() => boolean} [o.isSuspended] true while paused, while the bar is open, or switched off
   */
  constructor({screen, now, detector, onShake, isSuspended = () => false}) {
    this.screen = screen;
    this.now = now;
    this.detector = detector;
    this.onShake = onShake;
    this.isSuspended = isSuspended;
    this._x = null;
    this._y = null;
    this._wasSuspended = false;
  }

  /** One poll. Returns true when this sample completed a shake. */
  tick() {
    if (this.isSuspended()) {
      if (!this._wasSuspended) {
        this._wasSuspended = true;
        this.detector.reset();
      }
      this._x = null;
      return false;
    }
    this._wasSuspended = false;
    const p = this.screen.getCursorScreenPoint();
    if (p.x === this._x && p.y === this._y) return false;
    this._x = p.x;
    this._y = p.y;
    if (!this.detector.push(p.x, p.y, this.now())) return false;
    this.onShake();
    return true;
  }
}

/** Starts the 16 ms poll. Returns a stop function. */
export function startPolling(feed, {intervalMs = POLL_MS, setIntervalFn = setInterval, clearIntervalFn = clearInterval} = {}) {
  const id = setIntervalFn(() => feed.tick(), intervalMs);
  return () => clearIntervalFn(id);
}
