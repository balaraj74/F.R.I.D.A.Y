// Turns the raw screenshot into a small JPEG that fits in one gateway frame (512 KiB limit,
// minus base64 growth), using ffmpeg so the shell process never does image work.
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_RAW_BYTES = 330_000;
const STEPS = [
  {width: 1440, q: 5},
  {width: 1280, q: 7},
  {width: 1100, q: 10},
  {width: 900, q: 14},
  {width: 700, q: 20},
];

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-loglevel', 'error', '-y', ...args], {timeout: 10_000}, (err) => (err ? reject(err) : resolve()));
  });
}

/** Returns {base64, mimeType, bytes} or null when the picture cannot be prepared. */
export async function prepareScreenshot(pngPath, outDir = path.dirname(pngPath)) {
  const out = path.join(outDir, `${path.basename(pngPath, path.extname(pngPath))}.jpg`);
  for (const {width, q} of STEPS) {
    try {
      await ffmpeg(['-i', pngPath, '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(q), '-frames:v', '1', out]);
      const bytes = fs.statSync(out).size;
      if (bytes > 0 && bytes <= MAX_RAW_BYTES) {
        const base64 = fs.readFileSync(out).toString('base64');
        fs.rmSync(out, {force: true});
        return {base64, mimeType: 'image/jpeg', bytes};
      }
    } catch {
      fs.rmSync(out, {force: true});
      return null;
    }
  }
  fs.rmSync(out, {force: true});
  return null;
}
