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
        expect(run(wave(2000, 8, 12))).toBeNull();
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
