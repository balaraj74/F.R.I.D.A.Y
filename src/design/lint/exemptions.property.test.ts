import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scanFile } from "./index.js";
import type { Rule } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 14: Generated-file exemptions are rule-specific
// **Validates: Requirements 3.3**

const SCALE = ["sm", "md", "4px", "8px"];

const EXEMPT: readonly Rule[] = ["hex-color", "glow-shadow", "bad-radius"];
const STILL_REPORTED: readonly Rule[] = ["arbitrary-tailwind", "gradient"];
const ALL_RULES: readonly Rule[] = [...EXEMPT, ...STILL_REPORTED];

interface Entry {
  rule: Rule | null;
  text: string;
}

// Each violating snippet is a single line that triggers exactly one rule.
const violationFor: Record<Rule, fc.Arbitrary<Entry>> = {
  "hex-color": fc
    .constantFrom(3, 4, 6, 8)
    .chain((n) => fc.stringMatching(new RegExp(`^[0-9a-fA-F]{${n}}$`)))
    .map((h) => ({ rule: "hex-color" as const, text: `  color: #${h};` })),
  "arbitrary-tailwind": fc
    .tuple(
      fc.constantFrom("w", "h", "p", "mt", "top", "gap"),
      fc.integer({ min: 1, max: 999 }),
      fc.constantFrom("px", "rem", "%"),
    )
    .map(([prefix, n, unit]) => ({
      rule: "arbitrary-tailwind" as const,
      text: `<div className="flex ${prefix}-[${n}${unit}]" />`,
    })),
  "glow-shadow": fc
    .tuple(
      fc.integer({ min: 1, max: 60 }),
      fc.constantFrom("red", "blue", "rgba(0,0,0,.4)", "rgb(10 20 30)"),
    )
    .map(([blur, colour]) => ({
      rule: "glow-shadow" as const,
      text: `  box-shadow: 0 0 ${blur}px ${colour};`,
    })),
  gradient: fc.constantFrom("linear", "radial", "conic").map((fn) => ({
    rule: "gradient" as const,
    text: `  background: ${fn}-gradient(red, blue);`,
  })),
  "bad-radius": fc.oneof(
    fc
      .integer({ min: 1, max: 200 })
      .filter((n) => n !== 4 && n !== 8)
      .map((n) => ({ rule: "bad-radius" as const, text: `  border-radius: ${n}px;` })),
    fc.constantFrom("lg", "xl", "full", "2xl").map((size) => ({
      rule: "bad-radius" as const,
      text: `<div className="rounded-${size}" />`,
    })),
  ),
};

const violationArb: fc.Arbitrary<Entry> = fc.oneof(...ALL_RULES.map((r) => violationFor[r]));

const cleanArb: fc.Arbitrary<Entry> = fc.constantFrom(
  "  color: var(--color-fg);",
  "  border-radius: 4px;",
  '<div className="rounded-md p-2" />',
  "  box-shadow: var(--elevation-1);",
  "const x = 1;",
  "",
).map((text) => ({ rule: null, text }));

const fileArb = fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,3}\.(tsx|css|ts)$/);
const entriesArb = fc.array(fc.oneof(violationArb, cleanArb), { minLength: 1, maxLength: 40 });

const expectedFor = (file: string, entries: Entry[], keep: (rule: Rule) => boolean) =>
  entries.flatMap((e, i) =>
    e.rule !== null && keep(e.rule) ? [{ file, line: i + 1, rule: e.rule }] : [],
  );

describe("Property 14: Generated-file exemptions are rule-specific", () => {
  it("skips hex-color, glow-shadow and bad-radius but still reports arbitrary-tailwind and gradient", () => {
    fc.assert(
      fc.property(fileArb, entriesArb, (file, entries) => {
        const content = entries.map((e) => e.text).join("\n");
        const found = scanFile(file, content, SCALE, true);

        // No exempt rule appears anywhere in the output.
        expect(found.filter((v) => EXEMPT.includes(v.rule))).toEqual([]);
        // Every non-exempt violation is still reported at its line.
        expect(found).toEqual(expectedFor(file, entries, (r) => STILL_REPORTED.includes(r)));
      }),
      { numRuns: 200 },
    );
  });

  it("reports each of the five rules when the file is not generated", () => {
    fc.assert(
      fc.property(fileArb, entriesArb, (file, entries) => {
        const content = entries.map((e) => e.text).join("\n");
        const found = scanFile(file, content, SCALE, false);
        expect(found).toEqual(expectedFor(file, entries, () => true));
      }),
      { numRuns: 200 },
    );
  });

  it("each single rule is exempt or reported according to its category", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_RULES).chain((rule) => violationFor[rule]),
        (entry) => {
          const rule = entry.rule as Rule;
          const generated = scanFile("g.css", entry.text, SCALE, true).map((v) => v.rule);
          const normal = scanFile("g.css", entry.text, SCALE, false).map((v) => v.rule);
          expect(normal).toEqual([rule]);
          expect(generated).toEqual(EXEMPT.includes(rule) ? [] : [rule]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
