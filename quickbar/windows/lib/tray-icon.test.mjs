import {describe, expect, it} from 'vitest';
import {renderTrayBgra} from './tray-icon.mjs';

describe('tray icon', () => {
  it('is size*size BGRA with a transparent corner and an opaque ring', () => {
    const b = renderTrayBgra(32);
    expect(b.length).toBe(32 * 32 * 4);
    expect(b[3]).toBe(0); // top-left corner
    expect(Math.max(...Array.from({length: 32}, (_, x) => b[(16 * 32 + x) * 4 + 3]))).toBe(255);
  });
  it('is cyan normally and amber when paused', () => {
    const solid = (buf) => {
      for (let i = 0; i < buf.length; i += 4) if (buf[i + 3] === 255) return [buf[i + 2], buf[i + 1], buf[i]];
      return null;
    };
    expect(solid(renderTrayBgra(32))).toEqual([0, 229, 255]);
    expect(solid(renderTrayBgra(32, {paused: true}))).toEqual([255, 181, 71]);
  });
});
