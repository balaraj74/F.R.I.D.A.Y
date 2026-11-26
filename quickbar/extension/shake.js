// Detects a deliberate mouse shake: several quick reversals along one line.
//
// Pure logic with no GNOME imports, so it runs in the shell (GJS) and in Node tests.
//
// A shake is accepted when, inside a short window, the pointer
//   1. reverses direction at least `minReversals` times along its main axis,
//   2. travels at least `minStroke` pixels between reversals, and
//   3. stays close to a line (the spread across the main axis is small).
// Fast straight travel has no reversals, an overshoot has one or two small ones, and a circular
// scribble fails the "close to a line" test, so none of them trigger.

export const SHAKE_DEFAULTS = Object.freeze({
    // Four shakes: out and back four times is eight strokes and seven changes of direction.
    windowMs: 1500,
    minStroke: 15,
    minReversals: 7,
    maxCrossRatio: 0.6,
    // A shake is fast; slow back-and-forth positioning is not.
    minSpeed: 250,
    cooldownMs: 1500,
    evalEveryMs: 16,
});

export class ShakeDetector {
    constructor(options = {}) {
        this._o = {...SHAKE_DEFAULTS, ...options};
        this._t = [];
        this._x = [];
        this._y = [];
        this._lastEval = -Infinity;
        this._lastFire = -Infinity;
    }

    /** Forget the recent path (use when a drag starts or the pointer jumps). */
    reset() {
        this._t.length = 0;
        this._x.length = 0;
        this._y.length = 0;
    }

    /**
     * Feed one pointer sample. Returns true when a shake was just recognised.
     * @param {number} x pixels
     * @param {number} y pixels
     * @param {number} t milliseconds (any monotonic clock)
     */
    push(x, y, t) {
        const o = this._o;
        this._t.push(t);
        this._x.push(x);
        this._y.push(y);
        this._prune(t - o.windowMs);
        if (t - this._lastFire < o.cooldownMs) return false;
        if (t - this._lastEval < o.evalEveryMs) return false;
        this._lastEval = t;
        if (!this._looksShaken()) return false;
        this._lastFire = t;
        this.reset();
        return true;
    }

    _prune(cutoff) {
        let n = 0;
        while (n < this._t.length && this._t[n] < cutoff) n++;
        if (n > 0) {
            this._t.splice(0, n);
            this._x.splice(0, n);
            this._y.splice(0, n);
        }
    }

    /** What the recent path looks like; used by the decision and by the debug log. */
    metrics(strokeOverride) {
        const n = this._t.length;
        const empty = {n, reversals: 0, mainRange: 0, crossRange: 0, speed: 0, path: 0};
        if (n < 8) return empty;
        const o = this._o;
        const minStroke = strokeOverride ?? o.minStroke;

        let mx = 0;
        let my = 0;
        for (let i = 0; i < n; i++) {
            mx += this._x[i];
            my += this._y[i];
        }
        mx /= n;
        my /= n;

        // Principal axis of the path (2x2 covariance), so diagonal shakes count too.
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (let i = 0; i < n; i++) {
            const dx = this._x[i] - mx;
            const dy = this._y[i] - my;
            sxx += dx * dx;
            syy += dy * dy;
            sxy += dx * dy;
        }
        const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const ux = Math.cos(theta);
        const uy = Math.sin(theta);

        let reversals = 0;
        let dir = 0;
        let extreme = 0;
        let minU = Infinity;
        let maxU = -Infinity;
        let minW = Infinity;
        let maxW = -Infinity;
        let path = 0;
        for (let i = 0; i < n; i++) {
            const dx = this._x[i] - mx;
            const dy = this._y[i] - my;
            const u = dx * ux + dy * uy;
            const w = -dx * uy + dy * ux;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (w < minW) minW = w;
            if (w > maxW) maxW = w;
            if (i > 0) path += Math.hypot(this._x[i] - this._x[i - 1], this._y[i] - this._y[i - 1]);
            if (i === 0) {
                extreme = u;
                continue;
            }
            if (dir === 0) {
                if (Math.abs(u - extreme) >= minStroke) {
                    dir = u > extreme ? 1 : -1;
                    extreme = u;
                }
            } else if (dir > 0) {
                if (u > extreme) extreme = u;
                else if (extreme - u >= minStroke) {
                    reversals++;
                    dir = -1;
                    extreme = u;
                }
            } else {
                if (u < extreme) extreme = u;
                else if (u - extreme >= minStroke) {
                    reversals++;
                    dir = 1;
                    extreme = u;
                }
            }
        }
        const spanMs = Math.max(1, this._t[n - 1] - this._t[0]);
        return {n, reversals, mainRange: maxU - minU, crossRange: maxW - minW, speed: (path * 1000) / spanMs, path};
    }

    _looksShaken() {
        const m = this.metrics();
        const o = this._o;
        if (m.reversals < o.minReversals) return false;
        if (m.speed < o.minSpeed) return false;
        return m.mainRange > 0 && m.crossRange <= o.maxCrossRatio * m.mainRange;
    }
}
