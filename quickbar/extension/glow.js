// Geometry and colour for the light that runs around the bar, like Google's AI glow.
//
// Pure functions with no GNOME imports, so they run in the shell and in Node tests. The bar draws
// the result with Cairo; nothing here depends on how it is painted.

/** Google's four colours, in the order the light passes through them. */
export const GOOGLE_COLORS = Object.freeze([
    [66, 133, 244], // blue
    [234, 67, 53], // red
    [251, 188, 4], // yellow
    [52, 168, 83], // green
]);

/** Light behaviour for each thing FRIDAY can be doing. lapSeconds is how long one trip around the card takes. */
export const GLOW_MODES = Object.freeze({
    idle: {lapSeconds: 9, base: 0.5, peak: 0.95, width: 0.2, breathe: 0},
    thinking: {lapSeconds: 1.8, base: 0.75, peak: 1, width: 0.3, breathe: 0},
    speaking: {lapSeconds: 5, base: 0.65, peak: 1, width: 0.3, breathe: 0.25},
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

/** Smooth colour around the palette; u wraps, so 0 and 1 are the same colour. Components are 0..1. */
export function colorAt(u) {
    if (!Number.isFinite(u)) u = 0;
    const n = GOOGLE_COLORS.length;
    const p = (((u % 1) + 1) % 1) * n;
    const i = Math.floor(p) % n;
    const f = p - Math.floor(p);
    const t = f * f * (3 - 2 * f); // ease, so each colour holds a little before it blends
    const a = GOOGLE_COLORS[i];
    const b = GOOGLE_COLORS[(i + 1) % n];
    return [
        (a[0] + (b[0] - a[0]) * t) / 255,
        (a[1] + (b[1] - a[1]) * t) / 255,
        (a[2] + (b[2] - a[2]) * t) / 255,
    ];
}

/** Bright spot centred on `head` (a fraction of the perimeter), falling off both ways. 1 at the centre, near 0 far away. */
export function spot(u, head, width) {
    let d = Math.abs(u - head) % 1;
    if (d > 0.5) d = 1 - d;
    return Math.exp(-(d * d) / (2 * width * width));
}

/**
 * Everything the painter needs for one frame at time t (seconds): where the bright spot is and how
 * strong the light is overall.
 */
export function glowFrame(mode, t) {
    const m = GLOW_MODES[mode] ?? GLOW_MODES.idle;
    const head = ((t / m.lapSeconds) % 1 + 1) % 1;
    const breathe = m.breathe ? 1 - m.breathe * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.1)) : 1;
    return {head, width: m.width, base: m.base, peak: m.peak, gain: breathe, hueShift: t * 0.04};
}

/** Brightness (0..1) of the light at fraction u of the perimeter for a frame from glowFrame. */
export function intensityAt(frame, u) {
    return frame.gain * (frame.base + (frame.peak - frame.base) * spot(u, frame.head, frame.width));
}
