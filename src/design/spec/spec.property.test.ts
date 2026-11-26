import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REF_INDICES, SCREENS, STYLE_DIRECTIONS } from "../refs/plan.js";
import {
  DesignSpecError,
  NO_KEEP_OR_MIX_ERROR,
  canGenerateSpec,
  generateDesignSpec,
} from "./generate.js";
import type { SelectionEntry, SelectionFile, Verdict } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 8: Design_Spec requires and reflects selection verdicts
// **Validates: Requirements 2.1, 2.2**

const ACCEPTED: readonly Verdict[] = ["keep", "mix"];

/** Notes of 0 to 500 characters; any unicode, including CR/LF line breaks. */
const noteArb = fc.oneof(
  fc.string({ maxLength: 500 }),
  // Bias towards multi-line notes so continuation-line handling is exercised.
  fc.array(fc.string({ maxLength: 40 }), { minLength: 2, maxLength: 6 }).chain((lines) =>
    fc.constantFrom("\n", "\r\n", "\r").map((sep) => lines.join(sep)),
  ),
);

function entriesArb(verdicts: readonly Verdict[]): fc.Arbitrary<SelectionEntry[]> {
  const entry = fc.record({
    screen: fc.constantFrom(...SCREENS),
    direction: fc.constantFrom(...STYLE_DIRECTIONS),
    index: fc.constantFrom(...REF_INDICES),
    verdict: fc.constantFrom(...verdicts),
    note: noteArb,
  });
  // One entry per (screen, direction, index), as in a real Selection_File.
  return fc.uniqueArray(entry, {
    maxLength: 18,
    selector: (e) => `${e.screen}/${e.direction}/${e.index}`,
  });
}

const selectionArb = (verdicts: readonly Verdict[]): fc.Arbitrary<SelectionFile> =>
  entriesArb(verdicts).map((entries) => ({ version: 1 as const, entries }));

/** Selections with at least one keep or mix entry, mixed with reject entries. */
const acceptingSelectionArb: fc.Arbitrary<SelectionFile> = fc
  .tuple(
    selectionArb(["keep", "reject", "mix"]),
    fc.constantFrom(...ACCEPTED),
    fc.constantFrom(...SCREENS),
    fc.constantFrom(...STYLE_DIRECTIONS),
    fc.constantFrom(...REF_INDICES),
    noteArb,
  )
  .map(([base, verdict, screen, direction, index, note]) => {
    const key = (e: SelectionEntry) => `${e.screen}/${e.direction}/${e.index}`;
    const forced: SelectionEntry = { screen, direction, index, verdict, note };
    const entries = base.entries.filter((e) => key(e) !== key(forced));
    entries.push(forced);
    return { version: 1 as const, entries };
  });

/** Selections with only reject entries, or none at all. */
const rejectingSelectionArb: fc.Arbitrary<SelectionFile> = selectionArb(["reject"]);

/** Continuation lines of a multi-line note are indented, so check each line on its own. */
function noteLines(note: string): string[] {
  return note.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}

describe("Property 8: Design_Spec requires and reflects selection verdicts", () => {
  it("canGenerateSpec is true iff at least one entry is keep or mix", () => {
    fc.assert(
      fc.property(selectionArb(["keep", "reject", "mix"]), (selection) => {
        const expected = selection.entries.some((e) => ACCEPTED.includes(e.verdict));
        expect(canGenerateSpec(selection)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("generateDesignSpec throws DesignSpecError when there is no keep or mix verdict", () => {
    fc.assert(
      fc.property(rejectingSelectionArb, (selection) => {
        expect(canGenerateSpec(selection)).toBe(false);
        expect(() => generateDesignSpec(selection)).toThrow(DesignSpecError);
        expect(() => generateDesignSpec(selection)).toThrow(NO_KEEP_OR_MIX_ERROR);
      }),
      { numRuns: 100 },
    );
  });

  it("generateDesignSpec succeeds and reflects every keep/mix note in the output", () => {
    fc.assert(
      fc.property(acceptingSelectionArb, (selection) => {
        expect(canGenerateSpec(selection)).toBe(true);
        const spec = generateDesignSpec(selection);

        for (const entry of selection.entries) {
          if (!ACCEPTED.includes(entry.verdict)) {
            continue;
          }
          const lines = noteLines(entry.note);
          // Single-line notes appear verbatim; multi-line notes appear line by line.
          if (lines.length <= 1 && !/[\r\n]/.test(entry.note)) {
            if (entry.note.length > 0) {
              expect(spec).toContain(entry.note);
            }
          }
          for (const line of lines) {
            expect(spec).toContain(line);
          }
          // The verdict's reference is named too, so the bullet is traceable to its image.
          expect(spec).toContain(`${entry.screen} / ${entry.direction} #${entry.index + 1}`);
        }
      }),
      { numRuns: 200 },
    );
  });
});
