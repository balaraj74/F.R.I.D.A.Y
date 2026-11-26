import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REF_INDICES, SCREENS, STYLE_DIRECTIONS } from "./plan.js";
import {
  SELECTION_NOTE_MAX_LENGTH,
  SELECTION_VERDICTS,
  readSelection,
  writeSelection,
  type SelectionEntry,
  type SelectionFile,
} from "./selection.js";

// Notes of 0-500 UTF-16 units, including unicode, quotes, newlines and the exact 500 boundary.
const noteArb = fc.oneof(
  fc.string({ unit: "binary", maxLength: SELECTION_NOTE_MAX_LENGTH }),
  fc.constant("x".repeat(SELECTION_NOTE_MAX_LENGTH)),
  fc.constant(""),
);
const validNoteArb = noteArb.filter((s) => s.length <= SELECTION_NOTE_MAX_LENGTH);

const entryArb: fc.Arbitrary<SelectionEntry> = fc.record({
  screen: fc.constantFrom(...SCREENS),
  direction: fc.constantFrom(...STYLE_DIRECTIONS),
  index: fc.constantFrom(...REF_INDICES),
  verdict: fc.constantFrom(...SELECTION_VERDICTS),
  note: validNoteArb,
});

// A "set" of verdicts: at most one entry per (screen, direction, index).
const selectionFileArb: fc.Arbitrary<SelectionFile> = fc.record({
  version: fc.constant(1 as const),
  entries: fc.uniqueArray(entryArb, {
    maxLength: 18,
    selector: (e) => `${e.screen}/${e.direction}/${e.index}`,
  }),
});

describe("selection round-trip", () => {
  let tmpRoot: string;
  let counter = 0;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-selection-roundtrip-"));
  });

  afterAll(() => {
    // Remove only the temp directory this suite created.
    const tmpBase = path.resolve(os.tmpdir());
    const target = path.resolve(tmpRoot);
    if (path.dirname(target) === tmpBase && path.basename(target).startsWith("friday-selection-")) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  // Feature: friday-design-orchestrator-harness, Property 5: Selection round-trip
  // **Validates: Requirements 1.9, 1.11**
  it("Feature: friday-design-orchestrator-harness, Property 5: readSelection(writeSelection(x)) equals x", async () => {
    await fc.assert(
      fc.asyncProperty(selectionFileArb, selectionFileArb, async (first, second) => {
        const filePath = path.join(tmpRoot, `run-${counter++}`, "selection.json");

        await writeSelection(filePath, first);
        expect(readSelection(filePath)).toEqual(first);

        // Overwriting an existing valid file also round-trips and leaves no temp files behind.
        await writeSelection(filePath, second);
        expect(readSelection(filePath)).toEqual(second);
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(["selection.json"]);
      }),
      { numRuns: 100 },
    );
  });
});
