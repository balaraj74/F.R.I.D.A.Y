import {describe, expect, it} from 'vitest';
import {encodeWav16kMono, floatToPcm16, resample, wavFromPcm16} from './wav.mjs';

const ascii = (u8, from, to) => String.fromCharCode(...u8.slice(from, to));

describe('wav encoding', () => {
  it('writes a 44-byte PCM header for 16 kHz mono 16-bit', () => {
    const wav = wavFromPcm16(Int16Array.from([0, 1, -1, 32767]), 16000);
    const v = new DataView(wav.buffer);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 12)).toBe('WAVE');
    expect(ascii(wav, 12, 16)).toBe('fmt ');
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 40)).toBe('data');
    expect(v.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(44 + 8);
    expect(v.getInt16(44 + 4, true)).toBe(-1);
    expect(v.getInt16(44 + 6, true)).toBe(32767);
  });
  it('clamps and scales float samples', () => {
    expect(Array.from(floatToPcm16(Float32Array.from([-2, -1, 0, 0.5, 1, 2])))).toEqual([-32768, -32768, 0, 16384, 32767, 32767]);
  });
  it('downsamples 48 kHz to 16 kHz by a factor of three', () => {
    const input = new Float32Array(4800).fill(0.25);
    const out = resample(input, 48000, 16000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBeCloseTo(0.25);
    expect(out[1599]).toBeCloseTo(0.25);
  });
  it('averages samples when downsampling (a fast alternation becomes silence)', () => {
    const input = Float32Array.from({length: 600}, (_, i) => (i % 2 ? 1 : -1));
    const out = resample(input, 48000, 16000);
    for (const s of out) expect(Math.abs(s)).toBeLessThan(0.4);
  });
  it('upsamples 8 kHz to 16 kHz with interpolation', () => {
    const out = resample(Float32Array.from([0, 1, 0, 1]), 8000, 16000);
    expect(out.length).toBe(8);
    expect(out[1]).toBeCloseTo(0.5);
  });
  it('joins chunks and produces the length Whisper expects (32000 bytes per second)', () => {
    const chunks = [new Float32Array(24000).fill(0.1), new Float32Array(24000).fill(0.1)]; // 1 s at 48 kHz
    const wav = encodeWav16kMono(chunks, 48000);
    expect(wav.length).toBe(44 + 32000);
    expect((wav.length - 44) / 32000).toBeCloseTo(1, 5);
  });
  it('keeps 16 kHz input unchanged in rate', () => {
    const wav = encodeWav16kMono([new Float32Array(160)], 16000);
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    expect(wav.length).toBe(44 + 320);
  });
});
