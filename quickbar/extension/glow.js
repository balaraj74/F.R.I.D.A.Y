// Geometry and colour for the light that runs around the bar, like Google's AI glow.
//
// Pure functions with no GNOME imports, so they run in the shell and in Node tests. The bar draws
// the result with Cairo; nothing here depends on how it is painted.

/**
 * FRIDAY's own colours, taken from the reactor: cool cyan when she is calm or speaking, sunlight red and
 * amber while she thinks. Each mood blends four colours around the card, the way Google's AI light blends
 * its own four, but in FRIDAY's hues.
 */
export const GLOW_PALETTES = Object.freeze({
    idle: [
        [0, 229, 255], // reactor cyan
        [56, 189, 248], // sky
        [2, 132, 199], // deep blue
        [92, 242, 255], // ice
    ],
    thinking: [
        [255, 77, 46], // sunlight red
        [255, 181, 71], // amber
        [255, 158, 61], // orange
        [194, 38, 27], // deep red
    ],
    speaking: [
        [125, 211, 252], // light blue
        [0, 229, 255], // reactor cyan
        [255, 181, 71], // amber
        [230, 251, 255], // white-blue
    ],
});

/**
 * Light behaviour for each thing FRIDAY can be doing. The light is a few bright comets that run around
 * the edge, each with a tail that fades behind it, over a faint glow that is always there.
 *   lapSeconds  time for one trip around the card
 *   heads       how many comets, spread evenly around the card
 *   tail        how far behind a comet its tail reaches, as a fraction of the way round
 *   base        brightness of the faint glow between comets (0..1)
 *   breathe     how much the whole light pulses (0 = steady)
 */
export const GLOW_MODES = Object.freeze({
    idle: {lapSeconds: 4.5, heads: 2, tail: 0.16, base: 0.07, breathe: 0},
    thinking: {lapSeconds: 1.5, heads: 3, tail: 0.24, base: 0.16, breathe: 0},
    speaking: {lapSeconds: 3, heads: 2, tail: 0.22, base: 0.14, breathe: 0.3},
});

/**
 * Points along the outline of a rounded rectangle, evenly spaced, starting at the top-left corner's
 * end and going clockwise.
 * @returns {Array<[number, number]>} n points; point i is at fraction i / n of the perimeter
 */
export function roundedRectPoints(w, h, r, n) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    const straightW = w - 2 * radius;
    const straightH = h - 2 * radius;
    const arc = (Math.PI / 2) * radius;
    const corner = (cx, cy, from) => d => {
        const a = from + d / radius;
        return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
    };
    // Clockwise from the end of the top-left corner: each side, then the corner that follows it.
    const segments = [
        {len: straightW, at: d => [radius + d, 0]},
        {len: arc, at: corner(w - radius, radius, -Math.PI / 2)},
        {len: straightH, at: d => [w, radius + d]},
        {len: arc, at: corner(w - radius, h - radius, 0)},
        {len: straightW, at: d => [w - radius - d, h]},
        {len: arc, at: corner(radius, h - radius, Math.PI / 2)},
        {len: straightH, at: d => [0, h - radius - d]},
        {len: arc, at: corner(radius, radius, Math.PI)},
    ];
    const total = segments.reduce((sum, seg) => sum + seg.len, 0);
    const pts = [];
    for (let i = 0; i < n; i++) {
        let d = (i / n) * total;
        let point = segments[segments.length - 1].at(segments[segments.length - 1].len);
        for (const seg of segments) {
            if (d < seg.len) {
                point = seg.at(d);
                break;
            }
            d -= seg.len;
        }
        pts.push(point);
    }
    return pts;
}

/**
 * Smooth colour around a palette (a mood name or a list of [r, g, b]); u wraps, so 0 and 1 are the same
 * colour. Components are 0..1.
 */
export function colorAt(u, palette = 'idle') {
    if (!Number.isFinite(u)) u = 0;
    const colors = typeof palette === 'string' ? (GLOW_PALETTES[palette] ?? GLOW_PALETTES.idle) : palette;
    const n = colors.length;
    const p = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(p) % n;
    const f = p - Math.floor(p);
    const t = f * f * (3 - 2 * f); // ease, so each colour holds a little before it blends
    const a = colors[i];
    const b = colors[(i + 1) % n];
    return [
        (a[0] + (b[0] - a[0]) * t) / 255,
        (a[1] + (b[1] - a[1]) * t) / 255,
        (a[2] + (b[2] - a[2]) * t) / 255,
    ];
}

/** Mixes two colours from colorAt; k = 0 gives a, k = 1 gives b. Used to fade between moods. */
export function mixColors(a, b, k) {
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** A comet's brightness at fraction u of the perimeter: 1 at its head, fading behind it, nothing ahead of it. */
export function comet(u, head, tail) {
    const behind = (((head - u) % 1) + 1) % 1; // 0 at the head, growing as you move back along its path
    return Math.exp(-behind / tail);
}

/**
 * Everything the painter needs for one frame at time t (seconds): where the comets are and how strong
 * the light is overall.
 */
export function glowFrame(mode, t) {
    const m = GLOW_MODES[mode] ?? GLOW_MODES.idle;
    const lead = ((t / m.lapSeconds) % 1 + 1) % 1;
    const heads = [];
    for (let i = 0; i < m.heads; i++) heads.push((lead + i / m.heads) % 1);
    const breathe = m.breathe ? 1 - m.breathe * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.1)) : 1;
    return {heads, tail: m.tail, base: m.base, gain: breathe, hueShift: t * 0.06};
}

/** Brightness (0..1) of the light at fraction u of the perimeter for a frame from glowFrame. */
export function intensityAt(frame, u) {
    let strongest = 0;
    for (const head of frame.heads) strongest = Math.max(strongest, comet(u, head, frame.tail));
    return frame.gain * Math.min(1, frame.base + (1 - frame.base) * strongest);
}
