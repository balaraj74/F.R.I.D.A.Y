import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {ShakeDetector} from '../../extension/shake.js';
import {POLL_MS, ShakeFeed, startPolling} from './shake-feed.mjs';

function rig({suspended = () => false} = {}) {
  let t = 1000;
  let p = {x: 800, y: 500};
  const calls = {n: 0};
  const screen = {
    getCursorScreenPoint: () => {
      calls.n++;
      return p;
    },
  };
  const hits = [];
  const feed = new ShakeFeed({screen, now: () => t, detector: new ShakeDetector(), onShake: () => hits.push(t), isSuspended: suspended});
  return {
    feed,
    hits,
    calls,
    move: (x, y) => {
      p = {x, y};
    },
    advance: (ms) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

/** n full out-and-back shakes of amplitude amp px at `hz`, sampled at 16 ms like the poll. */
function shake(r, {hz = 4, amp = 110, ms = 1200} = {}) {
  for (let e = 0; e <= ms; e += POLL_MS) {
    r.move(Math.round(800 + amp * Math.sin((2 * Math.PI * hz * e) / 1000)), 500);
    r.advance(POLL_MS);
    if (r.feed.tick()) return true;
  }
  return false;
}

describe('ShakeFeed', () => {
  it('fires once on four deliberate shakes', () => {
    const r = rig();
    expect(shake(r)).toBe(true);
    expect(r.hits).toHaveLength(1);
  });
  it('does not fire for two or three shakes', () => {
    const r = rig();
    expect(shake(r, {hz: 4, ms: 600})).toBe(false); // 2.4 cycles
    expect(r.hits).toHaveLength(0);
  });
  it('does not fire for slow back-and-forth positioning', () => {
    const r = rig();
    expect(shake(r, {hz: 1, amp: 60, ms: 4000})).toBe(false);
  });
  it('respects the 1.5 s cooldown', () => {
    const r = rig();
    expect(shake(r)).toBe(true);
    r.advance(100);
    expect(shake(r)).toBe(false); // still cooling down, and the path was reset
  });
  it('feeds the detector only when the pointer moved', () => {
    const push = vi.fn(() => false);
    const feed = new ShakeFeed({screen: {getCursorScreenPoint: () => ({x: 5, y: 5})}, now: () => 1, detector: {push, reset() {}}, onShake() {}});
    feed.tick();
    feed.tick();
    feed.tick();
    expect(push).toHaveBeenCalledTimes(1);
  });
  it('does not even read the pointer while suspended (bar open, paused, switched off)', () => {
    let off = true;
    const r = rig({suspended: () => off});
    for (let i = 0; i < 100; i++) r.feed.tick();
    expect(r.calls.n).toBe(0);
    off = false;
    expect(shake(r)).toBe(true);
  });
  it('forgets the path collected before a suspension', () => {
    let off = false;
    const r = rig({suspended: () => off});
    shake(r, {hz: 4, ms: 600});
    off = true;
    r.feed.tick();
    off = false;
    expect(shake(r, {hz: 4, ms: 600})).toBe(false);
  });
});

describe('startPolling', () => {
  it('polls every 16 ms and can be stopped', () => {
    vi.useFakeTimers();
    const feed = {tick: vi.fn()};
    const stop = startPolling(feed);
    vi.advanceTimersByTime(160);
    expect(feed.tick).toHaveBeenCalledTimes(10);
    stop();
    vi.advanceTimersByTime(160);
    expect(feed.tick).toHaveBeenCalledTimes(10);
    vi.useRealTimers();
  });
});

describe('reuse', () => {
  it('uses extension/shake.js with its Linux defaults and the host does not copy it', () => {
    const d = new ShakeDetector();
    expect(d._o).toMatchObject({windowMs: 1500, minStroke: 15, minReversals: 7, minSpeed: 250, cooldownMs: 1500});
    const main = fs.readFileSync(fileURLToPath(new URL('../main.mjs', import.meta.url)), 'utf8');
    expect(main).toContain("from '../extension/shake.js'");
    expect(main).toContain("from '../daemon/gateway-client.mjs'");
    expect(main).toContain("from '../daemon/speak-text.mjs'");
    const overlay = fs.readFileSync(fileURLToPath(new URL('../overlay/overlay.mjs', import.meta.url)), 'utf8');
    expect(overlay).toContain("from '../../extension/glow.js'");
  });
});
