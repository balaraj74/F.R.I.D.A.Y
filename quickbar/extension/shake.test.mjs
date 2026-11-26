import {describe, expect, it} from 'vitest';
import {ShakeDetector} from './shake.js';

/** Feeds a path sampled every `dt` ms and returns the time (ms) of the first detection, or null. */
function run(path, dt = 8, detector = new ShakeDetector()) {
    let t = 1000;
    for (const [x, y] of path) {
        if (detector.push(x, y, t)) return t - 1000;
        t += dt;
    }
    return null;
}

const wave = (ms, hz, amp, {cx = 800, cy = 500, tilt = 0, wobble = 0} = {}) => {
    const pts = [];
    for (let t = 0; t <= ms; t += 8) {
        const u = amp * Math.sin((2 * Math.PI * hz * t) / 1000);
        const w = wobble * Math.sin((2 * Math.PI * 1.3 * t) / 1000);
        pts.push([cx + u * Math.cos(tilt) - w * Math.sin(tilt), cy + u * Math.sin(tilt) + w * Math.cos(tilt)]);
    }
    return pts;
};

describe('ShakeDetector', () => {
    it('fires on a deliberate horizontal shake, within about a second', () => {
        const t = run(wave(1200, 4, 110));
        expect(t).not.toBeNull();
        expect(t).toBeLessThan(1000);
    });

    it('fires on a diagonal and a vertical shake', () => {
        expect(run(wave(1200, 4, 110, {tilt: Math.PI / 4}))).not.toBeNull();
        expect(run(wave(1200, 4, 110, {tilt: Math.PI / 2}))).not.toBeNull();
    });

    it('fires on a shake that is a little sloppy', () => {
        expect(run(wave(1200, 4, 110, {wobble: 25}))).not.toBeNull();
    });

    it('ignores a fast straight sweep across the screen', () => {
        const path = [];
        for (let i = 0; i <= 40; i++) path.push([100 + i * 40, 300 + i * 6]);
        expect(run(path)).toBeNull();
    });

    it('ignores going to a target and coming back once', () => {
        const path = [];
        for (let i = 0; i <= 40; i++) path.push([100 + i * 15, 500]);
        for (let i = 0; i <= 40; i++) path.push([700 - i * 15, 500]);
        expect(run(path)).toBeNull();
    });

    it('ignores circular scribbling', () => {
        const path = [];
        for (let t = 0; t <= 2000; t += 8) {
            const a = (2 * Math.PI * 1.5 * t) / 1000;
            path.push([800 + 150 * Math.cos(a), 500 + 150 * Math.sin(a)]);
        }
        expect(run(path)).toBeNull();
    });

    it('ignores small hand tremor', () => {
        expect(run(wave(2000, 8, 4))).toBeNull();
    });

    it('ignores a slow wave', () => {
        expect(run(wave(4000, 0.5, 150))).toBeNull();
    });

    it('does not fire twice during the cool-down, then fires again', () => {
        const d = new ShakeDetector();
        let hits = 0;
        let t = 0;
        for (const [x, y] of wave(1200, 4, 110)) {
            if (d.push(x, y, t)) hits++;
            t += 8;
        }
        expect(hits).toBe(1);
        t += 2000;
        for (const [x, y] of wave(1200, 4, 110)) {
            if (d.push(x, y, t)) hits++;
            t += 8;
        }
        expect(hits).toBe(2);
    });

    it('survives irregular sample timing', () => {
        const d = new ShakeDetector();
        let t = 0;
        let fired = false;
        for (const [x, y] of wave(1400, 4, 110)) {
            t += 4 + ((x * 7) % 9);
            if (d.push(x, y, t)) fired = true;
        }
        expect(fired).toBe(true);
    });
});

describe('ShakeDetector with a real hand', () => {
    it('fires on a small, fast shake', () => {
        expect(run(wave(1200, 6, 35))).not.toBeNull();
    });

    it('needs four shakes: two or three do not open it', () => {
        // wave(ms, hz): a shake is one full cycle, out and back.
        expect(run(wave(400, 5, 100))).toBeNull(); // 2 shakes
        expect(run(wave(600, 5, 100))).toBeNull(); // 3 shakes
        expect(run(wave(380, 8, 60))).toBeNull(); // 3 quick, small shakes
    });

    it('opens on four shakes, even small and quick ones', () => {
        expect(run(wave(1000, 4, 100))).not.toBeNull(); // 4 shakes, 100 px each way
        expect(run(wave(750, 6, 40))).not.toBeNull(); // 4.5 quick, small shakes
    });

    it('opens on four shakes over the time it takes a real hand', () => {
        expect(run(wave(1400, 3.2, 90))).not.toBeNull(); // slower, 4.5 shakes in under 1.5 s
    });

    it('fires on a shake with jitter in the samples', () => {
        const noisy = wave(1300, 4.5, 80).map(([x, y], i) => [x + ((i * 37) % 15) - 7, y + ((i * 53) % 13) - 6]);
        expect(run(noisy)).not.toBeNull();
    });

    it('does not fire on a slow side-to-side drift', () => {
        expect(run(wave(3000, 1, 120))).toBeNull();
    });

    it('can be made stricter or looser from the settings', () => {
        const small = wave(1200, 6, 15); // strokes of about 30 px
        expect(run(small, 8, new ShakeDetector({minStroke: 40}))).toBeNull();
        expect(run(small, 8, new ShakeDetector({minStroke: 10}))).not.toBeNull();
    });

    it('reports what it sees', () => {
        const d = new ShakeDetector({minReversals: 99}); // never fires, so the samples stay
        let t = 0;
        for (const [x, y] of wave(500, 4, 110)) d.push(x, y, (t += 8));
        const m = d.metrics();
        expect(m.reversals).toBeGreaterThanOrEqual(2);
        expect(m.speed).toBeGreaterThan(700);
        expect(m.mainRange).toBeGreaterThan(150);
    });
});
