import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkContrast } from "./contrast.js";
import { TOKEN_CATEGORIES, type TokenCategory, type TokenFile } from "./types.js";
import { validateTokenFile } from "./validate.js";

// Feature: friday-design-orchestrator-harness, Property 9: Token category coverage and contrast validation
// **Validates: Requirements 2.5, 2.6**

const MIN_RATIO = 4.5;

/** Independent WCAG 2.1 oracle, written from the spec rather than imported from contrast.ts. */
function oracleRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const d = hex.slice(1);
    const full = d.length === 3 ? [...d].map((c) => c + c).join("") : d;
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hexDigit = fc.constantFrom(..."0123456789abcdefABCDEF".split(""));
const hexColorArb = fc.oneof(
  fc.array(hexDigit, { minLength: 3, maxLength: 3 }).map((d) => `#${d.join("")}`),
  fc.array(hexDigit, { minLength: 6, maxLength: 6 }).map((d) => `#${d.join("")}`),
);

/** Non-empty record with CSS-safe names and values, for the non-colour categories. */
const scalarRecordArb = (value: string) =>
  fc
    .integer({ min: 1, max: 4 })
    .map((n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value])));

/** A structurally and semantically valid Token_File whose contrast pairs may or may not pass. */
const tokenFileArb: fc.Arbitrary<TokenFile> = fc
  .array(hexColorArb, { minLength: 1, maxLength: 6 })
  .chain((colors) => {
    const names = colors.map((_, i) => `c${i}`);
    const pairArb = fc.record({
      text: fc.constantFrom(...names),
      background: fc.constantFrom(...names),
    });
    return fc.record({
      version: fc.constant(1 as const),
      color: fc.constant(Object.fromEntries(colors.map((c, i) => [names[i]!, c]))),
      type: fc.constant({ body: "16px" } as TokenFile["type"]),
      spacing: scalarRecordArb("8px"),
      radius: scalarRecordArb("4px"),
      elevation: scalarRecordArb("0 1px 2px #0003"),
      motion: scalarRecordArb("120ms"),
      contrastPairs: fc.array(pairArb, { maxLength: 8 }),
    });
  });

/** Same as tokenFileArb, but only keeps pairs at or above 4.5:1, so the file is fully valid. */
const passingTokenFileArb: fc.Arbitrary<TokenFile> = tokenFileArb.map((tf) => ({
  ...tf,
  contrastPairs: (tf.contrastPairs ?? []).filter(
    (p) => oracleRatio(tf.color[p.text]!, tf.color[p.background]!) >= MIN_RATIO,
  ),
}));

const categoryArb = fc.constantFrom<TokenCategory>(...TOKEN_CATEGORIES);

describe("Feature: friday-design-orchestrator-harness, Property 9: Token category coverage and contrast validation", () => {
  it("accepts a file when all 6 categories are non-empty and every pair passes", () => {
    fc.assert(
      fc.property(passingTokenFileArb, (tf) => {
        const result = validateTokenFile(tf);
        expect(result.ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects a file with any category removed or empty, naming that category", () => {
    fc.assert(
      fc.property(
        passingTokenFileArb,
        categoryArb,
        fc.constantFrom("remove", "empty"),
        (tf, category, how) => {
          const input: Record<string, unknown> = { ...tf };
          if (how === "remove") delete input[category];
          else input[category] = {};
          const result = validateTokenFile(input);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.errors.map((e) => e.path)).toContain(`/${category}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("checkContrast flags exactly the pairs whose unrounded WCAG ratio is below 4.5", () => {
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        const expected = (tf.contrastPairs ?? [])
          .map((p) => ({
            fg: p.text,
            bg: p.background,
            ratio: oracleRatio(tf.color[p.text]!, tf.color[p.background]!),
          }))
          .filter((f) => f.ratio < MIN_RATIO);

        const actual = checkContrast(tf);
        expect(actual.map((f) => [f.fg, f.bg])).toEqual(expected.map((f) => [f.fg, f.bg]));
        actual.forEach((f, i) => {
          // Reported ratio is rounded to 2dp: within half a hundredth of the true ratio,
          // and carrying no more than 2 decimal places.
          expect(Math.abs(f.ratio - expected[i]!.ratio)).toBeLessThanOrEqual(0.005 + 1e-9);
          expect(Math.abs(f.ratio * 100 - Math.round(f.ratio * 100))).toBeLessThan(1e-6);
          // Rounding never pushes a flagged pair above the threshold.
          expect(f.ratio).toBeLessThanOrEqual(MIN_RATIO);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("validateTokenFile rejects iff some pair fails, reporting each failing pair with its 2dp ratio", () => {
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        const failing = checkContrast(tf);
        const result = validateTokenFile(tf);
        expect(result.ok).toBe(failing.length === 0);
        if (!result.ok) {
          const contrastErrors = result.errors.filter((e) => e.path.startsWith("/contrastPairs/"));
          expect(contrastErrors).toHaveLength(failing.length);
          const pairs = tf.contrastPairs ?? [];
          const failingIndexes = pairs
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => oracleRatio(tf.color[p.text]!, tf.color[p.background]!) < MIN_RATIO);
          failingIndexes.forEach(({ i }, n) => {
            expect(contrastErrors[n]?.path).toBe(`/contrastPairs/${i}`);
            expect(contrastErrors[n]?.reason).toContain(`${failing[n]!.ratio.toFixed(2)}:1`);
          });
        }
      }),
      { numRuns: 200 },
    );
  });
});
