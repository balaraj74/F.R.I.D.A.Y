import {describe, expect, it} from 'vitest';
import {GLOW_PALETTES} from '../../extension/glow.js';
import {initialActivity, reduceActivity as r} from './activity.mjs';

describe('activity', () => {
  it('goes idle -> thinking -> speaking -> idle', () => {
    let s = initialActivity();
    s = r(s, {type: 'question'}, 10);
    expect(s).toMatchObject({mode: 'thinking', prevMode: 'idle', changedAt: 10});
    s = r(s, {type: 'speaking', on: true}, 20);
    expect(s).toMatchObject({mode: 'speaking', prevMode: 'thinking'});
    s = r(s, {type: 'speaking', on: false}, 30);
    expect(s.mode).toBe('idle');
  });
  it('final ends thinking but not speaking', () => {
    expect(r(r(initialActivity(), {type: 'question'}), {type: 'final'}).mode).toBe('idle');
    const speaking = r(initialActivity(), {type: 'speaking', on: true});
    expect(r(speaking, {type: 'final'}).mode).toBe('speaking');
  });
  it('error always returns to idle; same mode does not restart the fade', () => {
    expect(r(r(initialActivity(), {type: 'question'}), {type: 'error'}).mode).toBe('idle');
    const t = r(initialActivity(), {type: 'question'}, 5);
    expect(r(t, {type: 'question'}, 99).changedAt).toBe(5);
  });
  it('speaking off does nothing unless speaking', () => {
    const t = r(initialActivity(), {type: 'question'});
    expect(r(t, {type: 'speaking', on: false}).mode).toBe('thinking');
  });
  it('tracks the microphone', () => {
    let s = r(initialActivity(), {type: 'mic', state: 'recording'});
    expect(s.recording).toBe(true);
    s = r(s, {type: 'mic', state: 'idle'});
    expect(s.recording).toBe(false);
    expect(r(s, {type: 'toggle-mic'}).recording).toBe(true);
  });
  it('uses the three FRIDAY palettes: idle cyan/blue, thinking red/amber, speaking cyan/amber', () => {
    const hasCyan = (p) => p.some(([r0, g, b]) => r0 === 0 && g === 229 && b === 255);
    const hasAmber = (p) => p.some(([r0, g, b]) => r0 === 255 && g === 181 && b === 71);
    const hasRed = (p) => p.some(([r0, g, b]) => r0 === 255 && g === 77 && b === 46);
    expect(hasCyan(GLOW_PALETTES.idle)).toBe(true);
    expect(hasRed(GLOW_PALETTES.thinking) && hasAmber(GLOW_PALETTES.thinking)).toBe(true);
    expect(hasCyan(GLOW_PALETTES.speaking) && hasAmber(GLOW_PALETTES.speaking)).toBe(true);
  });
});
