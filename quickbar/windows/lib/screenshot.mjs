// Captures every monitor before the overlay is shown, stitches them into one picture laid out like
// the desktop, and shrinks it to fit one gateway frame (same limit and steps as quickbar/daemon/shot.mjs).
import {MAX_RAW_BYTES} from '../../daemon/shot.mjs';

export {MAX_RAW_BYTES};
export const CAPTURE_TIMEOUT_MS = 1500;
export const FIRST_WIDTH = 1440;
// width / JPEG quality, widest and best first; ffmpeg q 5..20 on Linux maps to about 85..38 here.
export const SHOT_STEPS = Object.freeze([
  {width: 1440, quality: 85},
  {width: 1280, quality: 75},
  {width: 1100, quality: 65},
  {width: 900, quality: 50},
  {width: 700, quality: 38},
]);

/**
 * Lays displays out like the desktop, scaled so the whole desktop is `targetWidth` wide at most.
 * @param {Array<{id:number,bounds:{x:number,y:number,width:number,height:number}}>} displays
 */
export function planLayout(displays, targetWidth = FIRST_WIDTH) {
  if (!displays.length) return {width: 0, height: 0, scale: 1, tiles: []};
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const scale = Math.min(1, targetWidth / (maxX - minX));
  const tiles = displays.map((d) => ({
    id: d.id,
    x: Math.round((d.bounds.x - minX) * scale),
    y: Math.round((d.bounds.y - minY) * scale),
    width: Math.max(1, Math.round(d.bounds.width * scale)),
    height: Math.max(1, Math.round(d.bounds.height * scale)),
  }));
  const width = Math.max(...tiles.map((t) => t.x + t.width));
  const height = Math.max(...tiles.map((t) => t.y + t.height));
  return {width, height, scale, tiles};
}

/** Copies each tile's BGRA bitmap into one BGRA buffer (black where no display is). */
export function composeBgra(layout, bitmaps) {
  const out = Buffer.alloc(layout.width * layout.height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  layout.tiles.forEach((tile, i) => {
    const src = bitmaps[i];
    if (!src) return;
    for (let row = 0; row < tile.height; row++) {
      const from = row * tile.width * 4;
      const to = ((tile.y + row) * layout.width + tile.x) * 4;
      src.copy(out, to, from, from + tile.width * 4);
    }
  });
  return out;
}

/** First step whose JPEG fits. `encode(width, quality)` returns a Buffer. */
export function fitToLimit(encode, steps = SHOT_STEPS, max = MAX_RAW_BYTES) {
  for (const {width, quality} of steps) {
    const jpeg = encode(width, quality);
    if (jpeg && jpeg.length > 0 && jpeg.length <= max) {
      return {base64: jpeg.toString('base64'), mimeType: 'image/jpeg', bytes: jpeg.length};
    }
  }
  return null;
}

/**
 * Takes the picture. Electron objects are injected so tests can fake them.
 * @returns {Promise<{image:{base64,mimeType,bytes}|null, partial:boolean}>}
 *   partial is true when some display could not be read (protected content, capture error).
 */
export async function captureDesktop({desktopCapturer, screen, nativeImage, timeoutMs = CAPTURE_TIMEOUT_MS, firstWidth = FIRST_WIDTH}) {
  const displays = screen.getAllDisplays().map((d) => ({id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor ?? 1}));
  const layout = planLayout(displays, firstWidth);
  if (!layout.tiles.length) return {image: null, partial: true};
  const biggest = layout.tiles.reduce((a, t) => (t.width * t.height > a.width * a.height ? t : a), layout.tiles[0]);
  const work = desktopCapturer.getSources({types: ['screen'], thumbnailSize: {width: biggest.width, height: biggest.height}});
  let timer;
  const sources = await Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!sources) return {image: null, partial: true};
  let partial = false;
  const bitmaps = layout.tiles.map((tile, i) => {
    const src = sources.find((s) => String(s.display_id) === String(tile.id)) ?? (sources.length === layout.tiles.length ? sources[i] : null);
    let img = src?.thumbnail;
    if (!img || img.isEmpty()) {
      partial = true;
      return null;
    }
    const size = img.getSize();
    if (size.width !== tile.width || size.height !== tile.height) img = img.resize({width: tile.width, height: tile.height});
    const bmp = img.toBitmap();
    if (bmp.length !== tile.width * tile.height * 4) {
      partial = true;
      return null;
    }
    return bmp;
  });
  if (bitmaps.every((b) => !b)) return {image: null, partial: true};
  const whole = nativeImage.createFromBitmap(composeBgra(layout, bitmaps), {width: layout.width, height: layout.height});
  const image = fitToLimit((width, quality) => {
    const scaled = width < layout.width ? whole.resize({width}) : whole;
    return scaled.toJPEG(quality);
  });
  return {image, partial};
}
