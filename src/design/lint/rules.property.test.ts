import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scanFile } from "./index.js";
import type { Rule } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 13: Design_Linter rule detection
// **Validates: Requirements 3.1, 3.2**

// Radius scale entries may be token keys (`md`, used by `rounded-md`) or values (`8px`).
const SCALE = ["sm", "md", "4px", "8px"];

interface Entry {
  /** Rule this line must trigger, or null for a line that must trigger nothing. */
  rule: Rule | null;
  text: string;
}

const hexDigits = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-fA-F]{${n}}$`));
const hexArb = fc.constantFrom(3, 4, 6, 8).chain(hexDigits);
const nameArb = fc.stringMatching(/^[a-z]{1,8}$/);

// Each violating snippet is one line and triggers exactly one rule.
const violationArb: fc.Arbitrary<Entry> = fc.oneof(
  hexArb.map((h) => ({ rule: "hex-color" as const, text: `  color: #${h};` })),
  fc
    .tuple(
      fc.constantFrom("w", "h", "p", "mt", "top", "gap"),
      fc.integer({ min: 1, max: 999 }),
      fc.constantFrom("px", "rem", "%"),
    )
    .map(([prefix, n, unit]) => ({
      rule: "arbitrary-tailwind" as const,
      text: `<div className="flex ${prefix}-[${n}${unit}]" />`,
    })),
  fc
    .tuple(
      fc.integer({ min: 1, max: 60 }),
      fc.constantFrom("red", "blue", "rgba(0,0,0,.4)", "rgb(10 20 30)"),
    )
    .map(([blur, colour]) => ({
      rule: "glow-shadow" as const,
      text: `  box-shadow: 0 0 ${blur}px ${colour};`,
    })),
  fc.constantFrom("linear", "radial", "conic").map((fn) => ({
    rule: "gradient" as const,
    text: `  background: ${fn}-gradient(red, blue);`,
  })),
  fc
    .integer({ min: 1, max: 200 })
    .filter((n) => n !== 4 && n !== 8)
    .map((n) => ({ rule: "bad-radius" as const, text: `  border-radius: ${n}px;` })),
  fc
    .constantFrom("lg", "xl", "full", "2xl")
    .map((size) => ({ rule: "bad-radius" as const, text: `<div className="rounded-${size}" />` })),
);

// Clean snippets must produce no violation of any rule.
const cleanArb: fc.Arbitrary<Entry> = fc.oneof(
  nameArb.map((n) => ({ rule: null, text: `  color: var(--color-${n});` })),
  fc.constantFrom("4px", "8px").map((r) => ({ rule: null, text: `  border-radius: ${r};` })),
  fc
    .constantFrom("sm", "md")
    .map((s) => ({ rule: null, text: `  border-radius: var(--radius-${s});` })),
  fc
    .constantFrom("sm", "md")
    .map((s) => ({ rule: null, text: `<div className="rounded-${s} p-2" />` })),
  fc.constantFrom(1, 2, 3).map((n) => ({ rule: null, text: `  box-shadow: var(--elevation-${n});` })),
  fc.constantFrom("const x = 1;", "", "// plain comment", "  display: flex;").map((text) => ({
    rule: null,
    text,
  })),
);

const fileArb = fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,3}\.(tsx|css|ts)$/);
const entriesArb = fc.array(fc.oneof(violationArb, cleanArb), { minLength: 1, maxLength: 40 });

const sortKey = (v: { line: number; rule: string }) => `${String(v.line).padStart(6, "0")}:${v.rule}`;

describe("Property 13: Design_Linter rule detection", () => {
  it("reports each off-system value with the correct file, 1-based line and rule", () => {
    fc.assert(
      fc.property(fileArb, entriesArb, (file, entries) => {
        const content = entries.map((e) => e.text).join("\n");
        const found = scanFile(file, content, SCALE, false);

        const expected = entries.flatMap((e, i) =>
          e.rule === null ? [] : [{ file, line: i + 1, rule: e.rule }],
        );
        // Every violating line is reported, and nothing is reported on clean lines.
        expect([...found].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual(
          [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("reports no violations for content with only in-system values", () => {
    fc.assert(
      fc.property(fileArb, fc.array(cleanArb, { minLength: 1, maxLength: 40 }), (file, entries) => {
        const content = entries.map((e) => e.text).join("\n");
        expect(scanFile(file, content, SCALE, false)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("reports the correct line when violations are preceded by multi-line clean blocks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        violationArb,
        fc.array(cleanArb, { maxLength: 5 }),
        (padding, violation, tail) => {
          const lines = [
            ...Array.from({ length: padding }, () => "const filler = 1;"),
            violation.text,
            ...tail.map((e) => e.text),
          ];
          const found = scanFile("f.tsx", lines.join("\n"), SCALE, false);
          expect(found).toEqual([{ file: "f.tsx", line: padding + 1, rule: violation.rule }]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
