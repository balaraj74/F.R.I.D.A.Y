import { extractDeclarationValues, splitTopLevel } from "./parse.js";

const ZERO = /^[+-]?0*\.?0+[a-z%]*$/i;
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** Lower-cases and folds every zero length (`0`, `0px`, `0rem`) to `0`. */
function canonical(value: string): string {
  const v = value.trim().toLowerCase();
  return ZERO.test(v) ? "0" : v;
}

/**
 * Builds the lookup set for the Token_File radius scale. Entries may be token keys
 * (`md`, used by `rounded-md`) or token values (`8px`, used by `border-radius`).
 */
export function buildRadiusScale(scale: readonly string[]): Set<string> {
  return new Set(scale.map(canonical));
}

function isAllowedCssToken(token: string, scale: Set<string>): boolean {
  const t = token.trim();
  const lower = t.toLowerCase();
  if (CSS_WIDE_KEYWORDS.has(lower)) {
    return true;
  }
  // `--radius-*` is the namespace the Token_Generator emits, so any reference to it is a token.
  if (/^var\(\s*--radius-[\w-]+\s*\)$/i.test(t)) {
    return true;
  }
  if (/^calc\(/i.test(t) && /var\(\s*--radius-/i.test(t)) {
    return true;
  }
  if (scale.has(canonical(t))) {
    return true;
  }
  // React style objects treat a bare number as pixels.
  return /^\d+(?:\.\d+)?$/.test(t) && scale.has(`${t}px`);
}

const RADIUS_DECLARATION =
  /(?<![\w-])(?:border-radius|border-(?:top|bottom)-(?:left|right)-radius|border-(?:start|end)-(?:start|end)-radius|borderRadius|border(?:Top|Bottom)(?:Left|Right)Radius|border(?:Start|End)(?:Start|End)Radius)["']?\s*:\s*/g;

// Tailwind `rounded`, `rounded-<side>`, `rounded-<size>`, `rounded-<side>-<size>`.
// Arbitrary values (`rounded-[8px]`) are left to the arbitrary-tailwind rule.
const RADIUS_CLASS =
  /(?<=^|[\s"'`:!])rounded(?:-(tl|tr|br|bl|ss|se|es|ee|t|r|b|l|s|e))?(?:-([A-Za-z0-9]+(?:\.\d+)?))?(?=$|[\s"'`}),;>])/gm;

/** Offsets of radius values that are not in the Token_File radius scale. */
export function findBadRadii(content: string, scale: Set<string>): number[] {
  const offsets: number[] = [];
  for (const decl of extractDeclarationValues(content, RADIUS_DECLARATION, [";", "}", ",", "\n"])) {
    const tokens = splitTopLevel(
      decl.value.replace(/!important/gi, ""),
      (ch) => /\s/.test(ch) || ch === "/",
    );
    if (tokens.some((t) => !isAllowedCssToken(t, scale))) {
      offsets.push(decl.index);
    }
  }
  for (const m of content.matchAll(RADIUS_CLASS)) {
    // A bare `rounded` is Tailwind's DEFAULT radius key. It is also a common identifier,
    // so only count it when it sits inside a string/template or an `@apply` on its line.
    if (m[1] === undefined && m[2] === undefined) {
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      if (!/["'`]|@apply/.test(content.slice(lineStart, m.index))) {
        continue;
      }
    }
    const size = m[2] ?? "DEFAULT";
    if (!scale.has(canonical(size))) {
      offsets.push(m.index);
    }
  }
  return offsets;
}
