import {describe, expect, it, vi} from 'vitest';
import {Speaker} from './speaker.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {promise, resolve};
};

describe('Speaker', () => {
  it('synthesizes then plays', async () => {
    const play = vi.fn(async () => true);
    const sp = new Speaker({synthesize: async () => ({mimeType: 'audio/wav', bytes: new Uint8Array(1)}), play, stopPlayback: vi.fn()});
    expect(await sp.say('hello')).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it('returns false and plays nothing when there is no audio', async () => {
    const play = vi.fn();
    const sp = new Speaker({synthesize: async () => null, play, stopPlayback() {}});
    expect(await sp.say('hello')).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });
  it('a newer request cancels one still being synthesized', async () => {
    const first = deferred();
    const play = vi.fn(async () => true);
    let n = 0;
    const sp = new Speaker({
      synthesize: () => (n++ === 0 ? first.promise : Promise.resolve({bytes: new Uint8Array(1)})),
      play,
      stopPlayback() {},
    });
    const a = sp.say('one');
    const b = sp.say('two');
    first.resolve({bytes: new Uint8Array(1)});
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
  });
  it('stop() cuts off playback in progress', async () => {
    const playing = deferred();
    const stopPlayback = vi.fn(() => playing.resolve(false));
    const sp = new Speaker({synthesize: async () => ({bytes: new Uint8Array(1)}), play: () => playing.promise, stopPlayback});
    const said = sp.say('long text');
    await new Promise((r) => setTimeout(r, 0));
    sp.stop();
    expect(stopPlayback).toHaveBeenCalledTimes(1);
    expect(await said).toBe(false);
  });
  it('swallows synthesis errors', async () => {
    const sp = new Speaker({synthesize: async () => { throw new Error('x'); }, play: vi.fn(), stopPlayback() {}});
    expect(await sp.say('hi')).toBe(false);
  });
});
