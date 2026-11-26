import {describe, expect, it} from 'vitest';
import {GLOW_MODES, colorAt, glowFrame, intensityAt, roundedRectPoints, spot} from './glow.js';

describe('roundedRectPoints', () => {
    it('returns the requested number of points, all on or inside the box', () => {
        const pts = roundedRectPoints(400, 200, 24, 200);
        expect(pts).toHaveLength(200);
        for (const [x, y] of pts) {
            expect(x).toBeGreaterThanOrEqual(-1e-9);
            expect(x).toBeLessThanOrEqual(400 + 1e-9);
            expect(y).toBeGreaterThanOrEqual(-1e-9);
            expect(y).toBeLessThanOrEqual(200 + 1e-9);
        }
    });

    it('starts on the top edge, passes the right edge and ends near where it began', () => {
        const pts = roundedRectPoints(400, 200, 24, 400);
        expect(pts[0][1]).toBeCloseTo(0);
        expect(pts.some(([x]) => Math.abs(x - 400) < 1e-6)).toBe(true);
        expect(pts.some(([, y]) => Math.abs(y - 200) < 1e-6)).toBe(true);
        expect(pts.some(([x]) => Math.abs(x) < 1e-6)).toBe(true);
        const [lx, ly] = pts[pts.length - 1];
        expect(Math.hypot(lx - pts[0][0], ly - pts[0][1])).toBeLessThan(12);
    });

    it('keeps neighbouring points about the same distance apart', () => {
        const pts = roundedRectPoints(400, 200, 24, 300);
        const gaps = pts.map((p, i) => Math.hypot(p[0] - pts[(i + 1) % pts.length][0], p[1] - pts[(i + 1) % pts.length][1]));
        expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.3);
    });

    it('survives a radius larger than the box', () => {
        const pts = roundedRectPoints(60, 40, 500, 40);
        expect(pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    });
});

describe('colorAt', () => {
    it('is the same at 0 and 1 and stays in range', () => {
        expect(colorAt(0)).toEqual(colorAt(1));
        for (let u = -1; u < 2; u += 0.07) {
            for (const c of colorAt(u)) {
                expect(c).toBeGreaterThanOrEqual(0);
                expect(c).toBeLessThanOrEqual(1);
            }
        }
    });

    it('starts blue and reaches red a quarter of the way round', () => {
        const [r, , b] = colorAt(0);
        expect(b).toBeGreaterThan(r);
        const [r2, , b2] = colorAt(0.25);
        expect(r2).toBeGreaterThan(b2);
    });
});

describe('light', () => {
    it('is brightest at the head and wraps around the perimeter', () => {
        expect(spot(0.5, 0.5, 0.2)).toBeCloseTo(1);
        expect(spot(0.02, 0.98, 0.2)).toBeGreaterThan(spot(0.5, 0.98, 0.2));
    });

    it('thinking runs faster and brighter than idle', () => {
        expect(GLOW_MODES.thinking.lapSeconds).toBeLessThan(GLOW_MODES.idle.lapSeconds);
        expect(GLOW_MODES.thinking.base).toBeGreaterThan(GLOW_MODES.idle.base);
    });

    it('moves the head over time and never leaves 0..1', () => {
        const a = glowFrame('idle', 0);
        const b = glowFrame('idle', 2);
        expect(b.head).toBeGreaterThan(a.head);
        for (const mode of Object.keys(GLOW_MODES)) {
            for (let t = 0; t < 12; t += 0.3) {
                const f = glowFrame(mode, t);
                for (let u = 0; u < 1; u += 0.05) {
                    const v = intensityAt(f, u);
                    expect(v).toBeGreaterThanOrEqual(0);
                    expect(v).toBeLessThanOrEqual(1.0001);
                }
            }
        }
    });

    it('breathes while speaking', () => {
        const gains = new Set();
        for (let t = 0; t < 2; t += 0.1) gains.add(glowFrame('speaking', t).gain.toFixed(2));
        expect(gains.size).toBeGreaterThan(3);
    });
});
