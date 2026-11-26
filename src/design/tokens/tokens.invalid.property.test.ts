import fc from "fast-check";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens } from "./build.js";

// Feature: friday-design-orchestrator-harness, Property 12: Invalid Token_File blocks all writes
// **Validates: Requirements 2.9**

type Json = Record<string, unknown>;

/** A valid Token_File with a few random, independently named extra tokens per category. */
function baseTokens(extras: Record<string, string[]>): Json {
  const withExtras = (fixed: Record<string, unknown>, cat: string, value: string): Json => {
    const out: Json = { ...fixed };
    for (const name of extras[cat] ?? []) out[`x${name}`] = value;
    return out;
  };
  return {
    version: 1,
    color: withExtras({ ink: "#111111", paper: "#ffffff" }, "color", "#336699"),
    type: withExtras(
      { body: { size: "16px", weight: 400 }, display: "Inter, sans-serif" },
      "type",
      "1rem",
    ),
    spacing: withExtras({ "2": "8px" }, "spacing", "4px"),
    radius: withExtras({ sm: "4px" }, "radius", "2px"),
    elevation: withExtras({ raised: "0 1px 2px #0003" }, "elevation", "none"),
    motion: withExtras({ fast: "120ms" }, "motion", "80ms"),
    contrastPairs: [{ text: "ink", background: "paper" }],
  };
}

const nameArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,5}$/);
const extrasArb = fc.record({
  color: fc.uniqueArray(nameArb, { maxLength: 3 }),
  type: fc.uniqueArray(nameArb, { maxLength: 3 }),
  spacing: fc.uniqueArray(nameArb, { maxLength: 3 }),
  radius: fc.uniqueArray(nameArb, { maxLength: 3 }),
  elevation: fc.uniqueArray(nameArb, { maxLength: 3 }),
  motion: fc.uniqueArray(nameArb, { maxLength: 3 }),
});

interface InvalidCase {
  /** Exact bytes written to the token file. */
  content: string;
  /** Paths the build must report (a superset check; each must appear with a reason). */
  expectedPaths: string[];
}

const CATEGORIES = ["color", "type", "spacing", "radius", "elevation", "motion"] as const;
const SIMPLE = ["color", "spacing", "radius", "elevation", "motion"] as const;

/** Structural failures: schema rejects the file, so only these paths are reported. */
const structuralArb: fc.Arbitrary<InvalidCase> = fc
  .tuple(
    extrasArb,
    fc.uniqueArray(
      fc.record({
        cat: fc.constantFrom(...CATEGORIES),
        mode: fc.constantFrom("missing", "empty", "nonString"),
      }),
      { minLength: 1, maxLength: 4, selector: (m) => m.cat },
    ),
    fc.boolean(),
  )
  .map(([extras, muts, badVersion]) => {
    const tf = baseTokens(extras);
    const expectedPaths: string[] = [];
    for (const { cat, mode } of muts) {
      if (mode === "missing") {
        delete tf[cat];
        expectedPaths.push(`/${cat}`);
      } else if (mode === "empty" || cat === "type") {
        // `type` values are unconstrained, so a non-string entry there is not a schema error.
        tf[cat] = {};
        expectedPaths.push(`/${cat}`);
      } else {
        (tf[cat] as Json).bad = 5;
        expectedPaths.push(`/${cat}/bad`);
      }
    }
    if (badVersion) {
      tf.version = 2;
      expectedPaths.push("/version");
    }
    return { content: JSON.stringify(tf), expectedPaths };
  });

type SemanticKind =
  | "badColor"
  | "badName"
  | "unsafeValue"
  | "unknownPairColour"
  | "lowContrast"
  | "nameCollision";

/** Value-level failures: schema passes, so every violation is reported together. */
const semanticArb: fc.Arbitrary<InvalidCase> = fc
  .tuple(
    extrasArb,
    fc.uniqueArray(
      fc.constantFrom<SemanticKind>(
        "badColor",
        "badName",
        "unsafeValue",
        "unknownPairColour",
        "lowContrast",
        "nameCollision",
      ),
      { minLength: 1 },
    ),
    fc.constantFrom("red", "#12", "#gggggg", "rgb(0,0,0)", "", "#12345678"),
    fc.constantFrom("Bad_Key", "UPPER", "has space", "-lead"),
    fc.constantFrom("4px; color: red", "a{b}", "x/*c*/", "a\\b", "", "  ", "a\nb"),
    fc.constantFrom("#777777", "#888888", "#999999", "#aaaaaa", "#bbbbbb"),
    fc.constantFrom(...SIMPLE.filter((c) => c !== "color")),
  )
  .map(([extras, kinds, badColor, badName, unsafe, lowGrey, nameCat]) => {
    const tf = baseTokens(extras);
    const color = tf.color as Json;
    const pairs = tf.contrastPairs as Array<{ text: string; background: string }>;
    const expectedPaths: string[] = [];
    for (const kind of kinds) {
      switch (kind) {
        case "badColor":
          color.bad = badColor;
          expectedPaths.push("/color/bad");
          break;
        case "badName":
          (tf[nameCat] as Json)[badName] = "1px";
          expectedPaths.push(`/${nameCat}/${badName}`);
          break;
        case "unsafeValue":
          (tf.radius as Json).unsafe = unsafe;
          expectedPaths.push("/radius/unsafe");
          break;
        case "unknownPairColour":
          pairs.push({ text: "no-such-colour", background: "paper" });
          expectedPaths.push(`/contrastPairs/${pairs.length - 1}/text`);
          break;
        case "lowContrast":
          color.lowfg = lowGrey;
          pairs.push({ text: "lowfg", background: "paper" });
          expectedPaths.push(`/contrastPairs/${pairs.length - 1}`);
          break;
        case "nameCollision":
          // {body:{size}} flattens to --type-body-size, same as a flat "body-size".
          (tf.type as Json)["body-size"] = "18px";
          expectedPaths.push("/type");
          break;
      }
    }
    return { content: JSON.stringify(tf), expectedPaths };
  });

/** Whole-file failures: not JSON, or JSON that is not an object. */
const wholeFileArb: fc.Arbitrary<InvalidCase> = fc
  .constantFrom("{nope", "", "[1,", "null", "[]", "42", '"text"', "true")
  .map((content) => ({ content, expectedPaths: [""] }));

const invalidCaseArb = fc.oneof(structuralArb, semanticArb, wholeFileArb);

/** Pre-existing output file: absent, or arbitrary bytes. */
const existingArb = fc.option(fc.uint8Array({ maxLength: 64 }), { nil: null });

/** Snapshot of a directory tree: `null` when absent, otherwise relative path -> file bytes (hex). */
async function snapshot(dir: string): Promise<Record<string, string> | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const rel of entries.sort()) {
    const stat = await fs.stat(path.join(dir, rel));
    out[rel] = stat.isDirectory()
      ? "<dir>"
      : (await fs.readFile(path.join(dir, rel))).toString("hex");
  }
  return out;
}

describe("Property 12: Invalid Token_File blocks all writes", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tokens-p12-"));
  });
  afterAll(async () => {
    // Only the directory created by this test file.
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports every invalid path, exits non-zero and leaves tokens.css / tailwind.tokens.js untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        invalidCaseArb,
        existingArb,
        existingArb,
        fc.boolean(),
        async (invalid, oldCss, oldTailwind, emptyOutDir) => {
          const dir = await fs.mkdtemp(path.join(root, "run-"));
          const outDir = path.join(dir, "out");
          const tokenFilePath = path.join(dir, "tokens.json");
          const cssPath = path.join(outDir, "tokens.css");
          const tailwindPath = path.join(outDir, "tailwind.tokens.js");

          await fs.writeFile(tokenFilePath, invalid.content, "utf8");
          if (oldCss || oldTailwind || emptyOutDir) await fs.mkdir(outDir);
          if (oldCss) await fs.writeFile(cssPath, oldCss);
          if (oldTailwind) await fs.writeFile(tailwindPath, oldTailwind);
          const before = await snapshot(outDir);

          const lines: string[] = [];
          const result = await buildTokens({
            tokenFilePath,
            cssPath,
            tailwindPath,
            writeError: (line) => lines.push(line),
          });

          // Non-zero exit and nothing reported as written.
          expect(result.exitCode).not.toBe(0);
          expect(result.written).toEqual([]);

          // Each expected invalid path is reported with a non-empty reason.
          const reported = new Map(result.errors.map((e) => [e.path, e.reason]));
          for (const p of invalid.expectedPaths) {
            expect(reported.get(p)?.length ?? 0, `no reason reported for "${p}"`).toBeGreaterThan(
              0,
            );
          }
          // Every reported error is also surfaced to the user as "<file>:<path>: <reason>".
          expect(lines).toEqual(
            result.errors.map((e) => `${tokenFilePath}:${e.path || "/"}: ${e.reason}`),
          );

          // Output directory is byte-identical: no new files, no temp files, no modified files.
          expect(await snapshot(outDir)).toEqual(before);
          if (!oldCss) await expect(fs.access(cssPath)).rejects.toThrow();
          if (!oldTailwind) await expect(fs.access(tailwindPath)).rejects.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
