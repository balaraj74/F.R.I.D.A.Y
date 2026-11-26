import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateOutputs } from "./generate.js";
import type { TokenFile, TypeTokenValue } from "./types.js";
import { validateTokenFile } from "./validate.js";

// Feature: friday-design-orchestrator-harness, Property 10: Generator output completeness
// **Validates: Requirements 2.7**

/** Token names: lowercase letters, digits and hyphens, starting with a letter or digit. */
const nameArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,7}$/);
/** Type token names avoid "-" so `{a: {b}}` can never collide with a flat `a-b`. */
const typeNameArb = fc.stringMatching(/^[a-z0-9]{1,6}$/);

/** Unique keys, built into an object with `Object.fromEntries` (no prototype surprises). */
function record<T>(key: fc.Arbitrary<string>, value: fc.Arbitrary<T>, maxKeys = 5) {
  return fc
    .uniqueArray(fc.tuple(key, value), {
      minLength: 1,
      maxLength: maxKeys,
      selector: ([k]) => k,
    })
    .map((entries) => Object.fromEntries(entries) as Record<string, T>);
}

const hexArb = fc.oneof(fc.stringMatching(/^#[0-9a-f]{3}$/), fc.stringMatching(/^#[0-9a-f]{6}$/));

/** Non-blank CSS-safe value: no declaration terminators, braces, backslashes, newlines or comments. */
const cssValueArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim() !== "" && !/[;{}\\\r\n]|\/\*|\*\//.test(s));

const scalarArb: fc.Arbitrary<string | number> = fc.oneof(
  cssValueArb,
  fc.integer({ min: -1000, max: 1000 }),
  // Normalise -0 to 0: String(-0) and JSON.stringify(-0) both give "0".
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (n === 0 ? 0 : n)),
);

const typeValueArb: fc.Arbitrary<TypeTokenValue> = fc.oneof(
  scalarArb,
  record(typeNameArb, scalarArb, 3),
);

const tokenFileArb: fc.Arbitrary<TokenFile> = fc.record({
  version: fc.constant(1 as const),
  color: record(nameArb, hexArb),
  type: record(typeNameArb, typeValueArb),
  spacing: record(nameArb, cssValueArb),
  radius: record(nameArb, cssValueArb),
  elevation: record(nameArb, cssValueArb),
  motion: record(nameArb, cssValueArb),
});

/** Category to the Tailwind `theme.extend` key it is emitted under. */
const TAILWIND_KEY = {
  color: "colors",
  type: "type",
  spacing: "spacing",
  radius: "borderRadius",
  elevation: "boxShadow",
  motion: "motion",
} as const;

/** Evaluates the generated `export default {...}` module body into a plain object. */
function loadTailwind(source: string): {
  theme: { extend: Record<string, Record<string, unknown>> };
} {
  const body = source.replace(/^\/\/.*\n/, "").replace(/^export default /, "");
  // The generator emits a plain object literal; this is test-only evaluation of that literal.
  return new Function(`return ${body}`)() as ReturnType<typeof loadTailwind>;
}

/** CSS custom property expected for each token, derived independently of `flattenTokens`. */
function expectedCssDeclarations(tf: TokenFile): string[] {
  const out: string[] = [];
  for (const category of ["color", "type", "spacing", "radius", "elevation", "motion"] as const) {
    for (const [key, value] of Object.entries(tf[category] as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        for (const [sub, subValue] of Object.entries(value)) {
          out.push(`  --${category}-${key}-${sub}: ${String(subValue)};`);
        }
      } else {
        out.push(`  --${category}-${key}: ${String(value)};`);
      }
    }
  }
  return out;
}

describe("Feature: friday-design-orchestrator-harness, Property 10: Generator output completeness", () => {
  it("generates valid TokenFiles (generator sanity check)", () => {
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        expect(validateTokenFile(tf).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("CSS output declares a custom property for every token", () => {
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        const { css } = generateOutputs(tf);
        const lines = new Set(css.split("\n"));
        for (const declaration of expectedCssDeclarations(tf)) {
          expect(lines.has(declaration), declaration).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Tailwind output contains every token under its theme key with its original value", () => {
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        const extend = loadTailwind(generateOutputs(tf).tailwind).theme.extend;
        for (const [category, themeKey] of Object.entries(TAILWIND_KEY)) {
          const expected = tf[category as keyof typeof TAILWIND_KEY] as Record<string, unknown>;
          const actual = extend[themeKey] ?? {};
          for (const [key, value] of Object.entries(expected)) {
            expect(Object.prototype.hasOwnProperty.call(actual, key), `${themeKey}.${key}`).toBe(
              true,
            );
            expect(actual[key], `${themeKey}.${key}`).toEqual(value);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
