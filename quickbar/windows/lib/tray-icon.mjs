// Draws the tray icon in code (a cyan ring with a dot; amber when paused), so there is no binary
// asset to ship. Returns a BGRA buffer, the format Electron's nativeImage.createFromBitmap takes.

const CYAN = [255, 229, 0]; // B, G, R of the reactor cyan (0, 229, 255)
const AMBER = [71, 181, 255]; // B, G, R of amber (255, 181, 71)

export function renderTrayBgra(size = 32, {paused = false} = {}) {
  const [b, g, r] = paused ? AMBER : CYAN;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.34;
  const dot = size * 0.14;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.min(1, Math.max(0, Math.min(d - inner + 0.5, outer - d + 0.5)));
      const core = Math.min(1, Math.max(0, dot - d + 0.5));
      const a = Math.max(ring, core);
      const i = (y * size + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}
