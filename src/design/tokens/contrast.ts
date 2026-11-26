import { MIN_CONTRAST_RATIO, type ContrastFailure, type TokenFile } from "./types.js";

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

function parseHex(hex: string): [number, number, number] {
  const digits = hex.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((c) => c + c)
          .join("")
      : digits;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two hex colours, unrounded, in the range 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/**
 * Returns every declared text/background pair whose ratio is below 4.5:1.
 * The threshold is applied to the unrounded ratio (WCAG forbids rounding up),
 * and the reported ratio is rounded to two decimal places. Pairs that refer to
 * a missing or non-hex colour token are skipped here; `validateTokenFile`
 * reports those separately.
 */
export function checkContrast(tf: TokenFile): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const pair of tf.contrastPairs ?? []) {
    const fg = tf.color[pair.text];
    const bg = tf.color[pair.background];
    if (fg === undefined || bg === undefined || !isHexColor(fg) || !isHexColor(bg)) {
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < MIN_CONTRAST_RATIO) {
      failures.push({ fg: pair.text, bg: pair.background, ratio: roundRatio(ratio) });
    }
  }
  return failures;
}
