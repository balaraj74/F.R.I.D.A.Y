import { extractDeclarationValues, splitTopLevel } from "./parse.js";

const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?$/i;
const ZERO_LENGTH = /^[+-]?0*\.?0+(?:[a-z%]+)?$/i;
const NON_SHADOW_KEYWORDS = new Set([
  "none",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);
// A whole-shadow or colour reference into the generated elevation tokens is the allowed form.
const ELEVATION_VAR = /^var\(\s*--elevation-/i;

/**
 * A layer is a glow when it has a non-zero blur radius (third length) and a colour
 * that is not an elevation token. Layers without a colour are not flagged.
 */
function isGlowLayer(layer: string): boolean {
  const parts = splitTopLevel(layer.replace(/!important/gi, ""), (ch) => /\s/.test(ch)).filter(
    (p) => p.toLowerCase() !== "inset",
  );
  const lengths: string[] = [];
  const colours: string[] = [];
  for (const part of parts) {
    if (LENGTH.test(part) || /^calc\(/i.test(part)) {
      lengths.push(part);
    } else {
      colours.push(part);
    }
  }
  if (lengths.length < 3 || colours.length === 0) {
    return false;
  }
  if (colours.some((c) => ELEVATION_VAR.test(c) || NON_SHADOW_KEYWORDS.has(c.toLowerCase()))) {
    return false;
  }
  return !ZERO_LENGTH.test(lengths[2] as string);
}

/** True when any comma-separated layer of a shadow value is a glow. */
export function isGlowShadowValue(value: string): boolean {
  return splitTopLevel(value, (ch) => ch === ",").some(isGlowLayer);
}

const SHADOW_DECLARATION = /(?<![\w-])(?:box-shadow|boxShadow)["']?\s*:\s*/g;
const SHADOW_ARBITRARY = /(?<=^|[\s"'`:!])(?:drop-|inset-)?shadow-\[([^\]\s]+)\]/gm;
const SHADOW_PALETTE =
  /(?<=^|[\s"'`:!])shadow-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?(?=$|[\s"'`}),;>])/gm;

/** Offsets of glow shadows: CSS/JS `box-shadow`, Tailwind `shadow-[...]`, and palette-coloured shadow classes. */
export function findGlowShadows(content: string): number[] {
  const offsets: number[] = [];
  for (const decl of extractDeclarationValues(content, SHADOW_DECLARATION, [";", "}"])) {
    if (isGlowShadowValue(decl.value)) {
      offsets.push(decl.index);
    }
  }
  for (const m of content.matchAll(SHADOW_ARBITRARY)) {
    // Tailwind encodes spaces in arbitrary values as underscores.
    if (isGlowShadowValue((m[1] as string).replaceAll("_", " "))) {
      offsets.push(m.index);
    }
  }
  for (const m of content.matchAll(SHADOW_PALETTE)) {
    offsets.push(m.index);
  }
  return offsets;
}
