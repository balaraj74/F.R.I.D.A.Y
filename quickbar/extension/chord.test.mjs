import {describe, expect, it} from 'vitest';
import {ChordDetector} from './chord.js';

function setup(holdMs = 110) {
    let now = 0;
    const timers = [];
    const schedule = (delay, fn) => {
        const timer = {at: now + delay, fn, live: true};
        timers.push(timer);
        return () => {
            timer.live = false;
        };
    };
    let fired = 0;
    const chord = new ChordDetector(schedule, () => fired++, {holdMs});
    const advance = ms => {
        now += ms;
        for (const t of timers) {
            if (t.live && t.at <= now) {
                t.live = false;
                t.fn();
            }
        }
    };
    return {chord, advance, fired: () => fired};
}

describe('ChordDetector', () => {
    it('fires when F and Space are held together long enough', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('f', true);
        advance(20);
        chord.onKey('space', true);
        advance(150);
        expect(fired()).toBe(1);
    });

    it('works with Space pressed first', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('space', true);
        chord.onKey('f', true);
        advance(150);
        expect(fired()).toBe(1);
    });

    it('does not fire on ordinary typing where the keys barely overlap', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('f', true);
        advance(40);
        chord.onKey('space', true);
        advance(20);
        chord.onKey('f', false);
        advance(300);
        chord.onKey('space', false);
        expect(fired()).toBe(0);
    });

    it('does not fire when F is typed then Space after releasing F', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('f', true);
        advance(60);
        chord.onKey('f', false);
        chord.onKey('space', true);
        advance(300);
        expect(fired()).toBe(0);
    });

    it('is cancelled by any other key', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('f', true);
        chord.onKey('space', true);
        advance(50);
        chord.onKey('other', true);
        advance(300);
        expect(fired()).toBe(0);
    });

    it('fires once per hold and again on the next hold', () => {
        const {chord, advance, fired} = setup();
        chord.onKey('f', true);
        chord.onKey('space', true);
        advance(500);
        expect(fired()).toBe(1);
        chord.onKey('f', false);
        chord.onKey('space', false);
        chord.onKey('f', true);
        chord.onKey('space', true);
        advance(500);
        expect(fired()).toBe(2);
    });
});
