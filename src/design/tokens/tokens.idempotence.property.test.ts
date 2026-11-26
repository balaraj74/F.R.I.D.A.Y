import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens } from "./build.js";
import { generateOutputs } from "./generate.js";
import type { TokenFile, TypeTokenValue } from "./types.js";
import { validateTokenFile } from "./validate.js";

// Feature: friday-design-orchestrator-harness, Property 11: Token Generator idempotence

// Token names: lowercase alphanumerics only. Hyphens are excluded so a flat type key can
// never collide with a flattened nested one (`a` + `b` -> `type-a-b`).
const nameArb = fc.stringMatching(/^[a-z0-9]{1,6}$/);
// CSS-safe scalar values: no `;{}\` or comment markers, not blank.
const valueArb = fc.stringMatching(/^[a-z0-9 .,#%()/-]{1,16}$/).filter((s) => s.trim() !== "");
const hexArb = fc.oneof(fc.stringMatching(/^#[0-9a-f]{3}$/), fc.stringMatching(/^#[0-9a-f]{6}$/));

function recordArb<T>(value: fc.Arbitrary<T>): fc.Arbitrary<Record<string, T>> {
  return fc
    .uniqueArray(fc.tuple(nameArb, value), {
      minLength: 1,
      maxLength: 6,
      selector: ([name]) => name,
    })
    .map((pairs) => Object.fromEntries(pairs));
}

const scalarArb: fc.Arbitrary<string | number> = fc.oneof(
  valueArb,
  fc.integer({ min: -1000, max: 1000 }),
);
const typeValueArb: fc.Arbitrary<TypeTokenValue> = fc.oneof(scalarArb, recordArb(scalarArb));

// `ink` (#000000) on `paper` (#ffffff) is a fixed passing pair, so contrast never rejects a sample.
const tokenFileArb: fc.Arbitrary<TokenFile> = fc
  .record({
    color: recordArb(hexArb),
    type: recordArb(typeValueArb),
    spacing: recordArb(valueArb),
    radius: recordArb(valueArb),
    elevation: recordArb(valueArb),
    motion: recordArb(valueArb),
    withPair: fc.boolean(),
  })
  .map(({ withPair, color, ...rest }): TokenFile => {
    const tf: TokenFile = { version: 1, color, ...rest };
    if (withPair) {
      tf.color = { ...color, ink: "#000000", paper: "#ffffff" };
      tf.contrastPairs = [{ text: "ink", background: "paper" }];
    }
    return tf;
  })
  .filter((tf) => validateTokenFile(tf).ok);

/** Small seeded PRNG (mulberry32) so a shuffle is reproducible from the fast-check seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rebuilds every object (recursively) with its keys inserted in a seeded random order. */
function shuffleKeys<T>(value: T, rand: () => number): T {
  if (Array.isArray(value) || typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [entries[i], entries[j]] = [entries[j] as (typeof entries)[number], entries[i] as never];
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v, rand)])) as T;
}

describe("Property 11: Token Generator idempotence", () => {
  let tmpRoot: string;
  let counter = 0;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tokens-idempotence-"));
  });

  afterAll(() => {
    // Remove only the temp directory this suite created.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("generates byte-identical CSS and Tailwind output on repeated runs", () => {
    // **Validates: Requirements 2.8**
    fc.assert(
      fc.property(tokenFileArb, (tf) => {
        const first = generateOutputs(tf);
        const second = generateOutputs(tf);
        expect(second.css).toBe(first.css);
        expect(second.tailwind).toBe(first.tailwind);
        // Generating must not mutate its input.
        expect(generateOutputs(structuredClone(tf))).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });

  it("is independent of the key order of the input", () => {
    // **Validates: Requirements 2.8**
    fc.assert(
      fc.property(tokenFileArb, fc.integer(), (tf, seed) => {
        const shuffled = shuffleKeys(tf, rng(seed));
        expect(validateTokenFile(shuffled).ok).toBe(true);
        const a = generateOutputs(tf);
        const b = generateOutputs(shuffled);
        expect(b.css).toBe(a.css);
        expect(b.tailwind).toBe(a.tailwind);
      }),
      { numRuns: 100 },
    );
  });

  it("buildTokens writes byte-identical files across runs, directories and key orders", async () => {
    // **Validates: Requirements 2.8**
    await fc.assert(
      fc.asyncProperty(tokenFileArb, fc.integer(), async (tf, seed) => {
        const runDir = path.join(tmpRoot, `run-${counter++}`);
        const paths = (name: string) => ({
          tokenFilePath: path.join(runDir, name, "tokens.json"),
          cssPath: path.join(runDir, name, "out", "tokens.css"),
          tailwindPath: path.join(runDir, name, "out", "tailwind.tokens.js"),
          writeError: () => {},
        });
        const build = async (name: string, input: TokenFile) => {
          const opts = paths(name);
          await fs.promises.mkdir(path.dirname(opts.tokenFilePath), { recursive: true });
          await fs.promises.writeFile(opts.tokenFilePath, JSON.stringify(input));
          const result = await buildTokens(opts);
          expect(result.exitCode).toBe(0);
          return {
            css: await fs.promises.readFile(opts.cssPath),
            tailwind: await fs.promises.readFile(opts.tailwindPath),
          };
        };

        const first = await build("a", tf);
        const second = await build("b", tf);
        // Same directory again: overwriting existing outputs yields the same bytes.
        const again = await buildTokens(paths("a"));
        expect(again.exitCode).toBe(0);
        const rewrittenCss = await fs.promises.readFile(paths("a").cssPath);
        const rewrittenTw = await fs.promises.readFile(paths("a").tailwindPath);
        const reordered = await build("c", shuffleKeys(tf, rng(seed)));

        for (const other of [second, { css: rewrittenCss, tailwind: rewrittenTw }, reordered]) {
          expect(other.css.equals(first.css)).toBe(true);
          expect(other.tailwind.equals(first.tailwind)).toBe(true);
        }
        // The files on disk match the pure generator.
        const pure = generateOutputs(tf);
        expect(first.css.toString("utf8")).toBe(pure.css);
        expect(first.tailwind.toString("utf8")).toBe(pure.tailwind);
      }),
      { numRuns: 30 },
    );
  });
});
