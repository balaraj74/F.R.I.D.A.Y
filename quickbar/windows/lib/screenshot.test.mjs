import {describe, expect, it, vi} from 'vitest';
import {MAX_RAW_BYTES as LINUX_MAX} from '../../daemon/shot.mjs';
import {MAX_RAW_BYTES, SHOT_STEPS, captureDesktop, composeBgra, fitToLimit, planLayout} from './screenshot.mjs';

const disp = (id, x, y, width, height) => ({id, bounds: {x, y, width, height}, scaleFactor: 1});

describe('planLayout', () => {
  it('scales a wide desktop to the target width', () => {
    const l = planLayout([disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1920, 1080)], 1440);
    expect(l.width).toBe(1440);
    expect(l.height).toBe(405);
    expect(l.tiles.map((t) => [t.x, t.width])).toEqual([[0, 720], [720, 720]]);
  });
  it('never scales up', () => {
    const l = planLayout([disp(1, 0, 0, 800, 600)], 1440);
    expect(l).toMatchObject({width: 800, height: 600, scale: 1});
  });
  it('handles negative origins', () => {
    const l = planLayout([disp(1, -1280, 0, 1280, 720), disp(2, 0, 0, 1920, 1080)], 3200);
    expect(l.tiles[0].x).toBe(0);
    expect(l.tiles[1].x).toBe(1280);
    expect(l.width).toBe(3200);
  });
  it('is empty for no displays', () => {
    expect(planLayout([]).tiles).toEqual([]);
  });
});

describe('composeBgra', () => {
  it('places each tile at its position on an opaque black canvas', () => {
    const layout = planLayout([disp(1, 0, 0, 2, 2), disp(2, 2, 0, 2, 1)], 100);
    const a = Buffer.alloc(2 * 2 * 4, 0xaa);
    const b = Buffer.alloc(2 * 1 * 4, 0xbb);
    const out = composeBgra(layout, [a, b]);
    expect(layout.width).toBe(4);
    expect(layout.height).toBe(2);
    expect(out[0]).toBe(0xaa);
    expect(out[(0 * 4 + 2) * 4]).toBe(0xbb); // row 0, x 2
    expect(out[(1 * 4 + 2) * 4]).toBe(0); // row 1, x 2: no display, black
    expect(out[(1 * 4 + 2) * 4 + 3]).toBe(255);
  });
});

describe('fitToLimit', () => {
  it('uses the same size limit as the Linux shot.mjs', () => {
    expect(MAX_RAW_BYTES).toBe(LINUX_MAX);
  });
  it('steps down until the picture fits', () => {
    const sizes = {1440: 500_000, 1280: 400_000, 1100: 300_000};
    const encode = vi.fn((w) => Buffer.alloc(sizes[w] ?? 1000));
    const r = fitToLimit(encode);
    expect(encode.mock.calls.map((c) => c[0])).toEqual([1440, 1280, 1100]);
    expect(r.bytes).toBe(300_000);
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.base64.length).toBe(Math.ceil(300_000 / 3) * 4);
  });
  it('gives null when nothing fits', () => {
    expect(fitToLimit(() => Buffer.alloc(MAX_RAW_BYTES + 1))).toBeNull();
    expect(SHOT_STEPS[0].width).toBe(1440);
  });
});

function fakeImage(w, h, fill) {
  return {
    isEmpty: () => w === 0,
    getSize: () => ({width: w, height: h}),
    resize: ({width, height}) => fakeImage(width, height ?? Math.round((h * width) / w), fill),
    toBitmap: () => Buffer.alloc(w * h * 4, fill),
    toJPEG: (q) => Buffer.alloc(1000 + q, fill),
  };
}

function fakeElectron(displays, sources) {
  return {
    screen: {getAllDisplays: () => displays.map((d) => ({id: d.id, bounds: d.bounds, scaleFactor: 1}))},
    desktopCapturer: {getSources: vi.fn(async () => sources)},
    nativeImage: {
      createFromBitmap: vi.fn((buf, {width, height}) => {
        const img = fakeImage(width, height, buf[0]);
        img.bitmap = buf;
        return img;
      }),
    },
  };
}

describe('captureDesktop', () => {
  it('captures every display and returns a small JPEG', async () => {
    const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1920, 1080)];
    const e = fakeElectron(displays, [
      {display_id: '2', thumbnail: fakeImage(720, 405, 2)},
      {display_id: '1', thumbnail: fakeImage(720, 405, 1)},
    ]);
    const r = await captureDesktop(e);
    expect(r.partial).toBe(false);
    expect(r.image.mimeType).toBe('image/jpeg');
    expect(r.image.bytes).toBeLessThanOrEqual(MAX_RAW_BYTES);
    const [bitmap, size] = e.nativeImage.createFromBitmap.mock.calls[0];
    expect(size).toEqual({width: 1440, height: 405});
    expect(bitmap[0]).toBe(1); // display 1 on the left
    expect(bitmap[(720) * 4]).toBe(2); // display 2 on the right
  });
  it('is partial when one display cannot be read, and null when none can', async () => {
    const displays = [disp(1, 0, 0, 800, 600), disp(2, 800, 0, 800, 600)];
    const one = fakeElectron(displays, [{display_id: '1', thumbnail: fakeImage(800, 600, 1)}]);
    const r = await captureDesktop(one);
    expect(r.partial).toBe(true);
    expect(r.image).not.toBeNull();
    const none = fakeElectron(displays, [{display_id: '1', thumbnail: fakeImage(0, 0, 0)}]);
    expect((await captureDesktop(none)).image).toBeNull();
  });
  it('gives up after the timeout', async () => {
    const e = fakeElectron([disp(1, 0, 0, 800, 600)], []);
    e.desktopCapturer.getSources = () => new Promise(() => {});
    const r = await captureDesktop({...e, timeoutMs: 20});
    expect(r).toEqual({image: null, partial: true});
  });
});
