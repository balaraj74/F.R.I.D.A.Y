import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const {
  readGeneratedImage,
  resolveGeneratedImage,
  readGeneratedMedia,
  resolveGeneratedMedia,
  getMediaKind,
} = createRequire(import.meta.url)('./media-access.cjs');

let dir: string;
let gen: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  gen = path.join(dir, 'generated');
  fs.mkdirSync(gen);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('generated picture access', () => {
  it('reads a picture from the generated folder as a data URL', () => {
    const f = path.join(gen, 'a.png');
    fs.writeFileSync(f, 'abc');
    expect(readGeneratedImage(f, [gen]).dataUrl).toBe('data:image/png;base64,YWJj');
  });

  it('refuses other folders, non-images and symlinks that escape', () => {
    const outside = path.join(dir, 'secret.png');
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(path.join(gen, 'notes.txt'), 'x');
    fs.symlinkSync(outside, path.join(gen, 'link.png'));
    expect(() => resolveGeneratedImage(outside, [gen])).toThrow(/outside/);
    expect(() => resolveGeneratedImage(path.join(gen, 'notes.txt'), [gen])).toThrow(/Not an image/);
    expect(() => resolveGeneratedImage(path.join(gen, 'link.png'), [gen])).toThrow(/outside/);
    expect(() => resolveGeneratedImage('/etc/passwd', [gen])).toThrow();
  });
});

describe('generated rich media access (video, audio, pdf, svg)', () => {
  it('resolves and reads video, audio, pdf, and svg files inside generated/', () => {
    const mp4 = path.join(gen, 'clip.mp4');
    const mp3 = path.join(gen, 'voice.mp3');
    const pdf = path.join(gen, 'report.pdf');
    const svg = path.join(gen, 'diagram.svg');
    fs.writeFileSync(mp4, 'mp4data');
    fs.writeFileSync(mp3, 'mp3data');
    fs.writeFileSync(pdf, 'pdfdata');
    fs.writeFileSync(svg, '<svg></svg>');

    expect(getMediaKind(mp4)).toBe('video');
    expect(getMediaKind(mp3)).toBe('audio');
    expect(getMediaKind(pdf)).toBe('pdf');
    expect(getMediaKind(svg)).toBe('image');

    expect(readGeneratedMedia(mp4, [gen]).mimeType).toBe('video/mp4');
    expect(readGeneratedMedia(mp3, [gen]).mimeType).toBe('audio/mpeg');
    expect(readGeneratedMedia(pdf, [gen]).mimeType).toBe('application/pdf');
    expect(readGeneratedMedia(svg, [gen]).mimeType).toBe('image/svg+xml');
  });

  it('refuses unsupported extensions and escaping symlinks for rich media', () => {
    const outside = path.join(dir, 'secret.mp4');
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(path.join(gen, 'script.sh'), 'echo hi');
    fs.symlinkSync(outside, path.join(gen, 'link.mp4'));

    expect(() => resolveGeneratedMedia(outside, [gen])).toThrow(/outside/);
    expect(() => resolveGeneratedMedia(path.join(gen, 'script.sh'), [gen])).toThrow(/Unsupported/);
    expect(() => resolveGeneratedMedia(path.join(gen, 'link.mp4'), [gen])).toThrow(/outside/);
  });
});
