import {describe, expect, it} from 'vitest';
import {LAYOUT, pickDisplay, placeOverlay, windowHeight} from './placement.mjs';

const d1 = {id: 1, bounds: {x: 0, y: 0, width: 1920, height: 1080}, workArea: {x: 0, y: 0, width: 1920, height: 1040}};
const d2 = {id: 2, bounds: {x: 1920, y: 0, width: 1600, height: 900}, workArea: {x: 1920, y: 0, width: 1600, height: 860}};
const displays = [d1, d2];

describe('placeOverlay', () => {
  it('puts the card below and right of the pointer', () => {
    const p = placeOverlay({pointer: {x: 400, y: 300}, displays, primaryId: 1});
    expect(p.card).toEqual({x: 414, y: 314, width: 500});
    expect(p.window.x).toBe(414);
  });
  it('subtracts the padding for the window rectangle', () => {
    const p = placeOverlay({pointer: {x: 400, y: 300}, displays, primaryId: 1, pad: 12});
    expect(p.window).toEqual({x: 402, y: 302, width: 524});
  });
  it('flips to the left of the pointer at the right screen edge', () => {
    const p = placeOverlay({pointer: {x: 1800, y: 300}, displays, primaryId: 1});
    expect(p.card.x).toBe(1800 - 14 - 500);
  });
  it('moves up by the smallest amount near the bottom edge', () => {
    const p = placeOverlay({pointer: {x: 400, y: 1000}, displays, primaryId: 1});
    const bottom = 1040 - LAYOUT.edgeGap;
    expect(p.card.y).toBe(bottom - (LAYOUT.headerRowHeight + LAYOUT.minAnswerHeight));
  });
  it('uses the display that holds the pointer', () => {
    const p = placeOverlay({pointer: {x: 2000, y: 100}, displays, primaryId: 1});
    expect(p.displayId).toBe(2);
    expect(p.card.x).toBe(2014);
  });
  it('stays inside a second display near its right edge', () => {
    const p = placeOverlay({pointer: {x: 3500, y: 100}, displays, primaryId: 1});
    expect(p.card.x + 500).toBeLessThanOrEqual(1920 + 1600 - LAYOUT.edgeGap);
    expect(p.card.x).toBeGreaterThanOrEqual(1920);
  });
  it('works with a display at negative coordinates', () => {
    const left = {id: 3, bounds: {x: -1280, y: 0, width: 1280, height: 720}, workArea: {x: -1280, y: 0, width: 1280, height: 680}};
    const p = placeOverlay({pointer: {x: -100, y: 50}, displays: [d1, left], primaryId: 1});
    expect(p.displayId).toBe(3);
    expect(p.card.x).toBe(-100 - 14 - 500);
  });
  it('limits the answer height to the room that is left', () => {
    expect(placeOverlay({pointer: {x: 10, y: 10}, displays, primaryId: 1}).answerMax).toBe(LAYOUT.maxAnswerHeight);
    const low = placeOverlay({pointer: {x: 10, y: 900}, displays, primaryId: 1});
    expect(low.answerMax).toBeGreaterThanOrEqual(LAYOUT.minAnswerHeight);
    expect(low.answerMax).toBeLessThanOrEqual(LAYOUT.maxAnswerHeight);
  });
});

describe('pickDisplay', () => {
  it('falls back to the primary display when the point is outside every display', () => {
    expect(pickDisplay(9999, 9999, displays, 2).id).toBe(2);
    expect(pickDisplay(9999, 9999, displays, 77).id).toBe(1);
  });
});

describe('windowHeight', () => {
  it('follows the content and never passes the work area bottom', () => {
    const p = placeOverlay({pointer: {x: 400, y: 300}, displays, primaryId: 1, pad: 12});
    expect(windowHeight(p, 200.2)).toBe(201 + 24);
    expect(windowHeight(p, 5000)).toBe(p.bottom - p.card.y + 24);
  });
});
