import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REF_INDICES, SCREENS, STYLE_DIRECTIONS } from "./plan.js";
import {
  SELECTION_NOTE_MAX_LENGTH,
  SELECTION_VERDICTS,
  writeSelection,
  type SelectionEntry,
  type SelectionFile,
} from "./selection.js";

// Feature: friday-design-orchestrator-harness, Property 6: Oversized notes are rejected without mutation
// **Validates: Requirements 1.10**

const entryArb = (note: fc.Arbitrary<string>): fc.Arbitrary<SelectionEntry> =>
  fc.record({
    screen: fc.constantFrom(...SCREENS),
    direction: fc.constantFrom(...STYLE_DIRECTIONS),
    index: fc.constantFrom(...REF_INDICES),
    verdict: fc.constantFrom(...SELECTION_VERDICTS),
    note,
  });

const validNoteArb = fc.string({ maxLength: SELECTION_NOTE_MAX_LENGTH });

// Notes strictly longer than the limit, in plain ASCII and in arbitrary unicode.
// Code-point arrays of length > 500 always have .length > 500 in UTF-16 units.
const oversizedNoteArb = fc.oneof(
  fc.string({ minLength: SELECTION_NOTE_MAX_LENGTH + 1, maxLength: 900 }),
  fc.string({ unit: "binary", minLength: SELECTION_NOTE_MAX_LENGTH + 1, maxLength: 700 }),
);

const validFileArb: fc.Arbitrary<SelectionFile> = fc.record({
  version: fc.constant(1 as const),
  entries: fc.array(entryArb(validNoteArb), { maxLength: 5 }),
});

// A file with at least one oversized note at a random position among valid entries.
const oversizedFileArb: fc.Arbitrary<SelectionFile> = fc
  .tuple(
    fc.array(entryArb(validNoteArb), { maxLength: 4 }),
    entryArb(oversizedNoteArb),
    fc.array(entryArb(validNoteArb), { maxLength: 4 }),
  )
  .map(([before, bad, after]) => ({ version: 1 as const, entries: [...before, bad, ...after] }));

describe("Feature: friday-design-orchestrator-harness, Property 6: oversized notes are rejected without mutation", () => {
  let baseDir: string;
  let counter = 0;

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-selection-oversized-"));
  });

  afterAll(() => {
    // Only the temp directory created in beforeAll is removed.
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function freshDir(): string {
    const dir = path.join(baseDir, `run-${counter++}`);
    fs.mkdirSync(dir);
    return dir;
  }

  it("rejects and leaves an existing Selection_File byte-for-byte unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(validFileArb, oversizedFileArb, async (existing, oversized) => {
        const dir = freshDir();
        const target = path.join(dir, "selection.json");
        await writeSelection(target, existing);
        const bytesBefore = fs.readFileSync(target);
        const listingBefore = fs.readdirSync(dir).toSorted();

        await expect(writeSelection(target, oversized)).rejects.toThrow();

        expect(fs.readFileSync(target).equals(bytesBefore)).toBe(true);
        // No leftover temp file next to the target.
        expect(fs.readdirSync(dir).toSorted()).toEqual(listingBefore);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects without creating the file, a temp file, or its parent directory when none existed", async () => {
    await fc.assert(
      fc.asyncProperty(oversizedFileArb, fc.boolean(), async (oversized, nested) => {
        const dir = freshDir();
        const parent = nested ? path.join(dir, "not-yet-created") : dir;
        const target = path.join(parent, "selection.json");

        await expect(writeSelection(target, oversized)).rejects.toThrow();

        expect(fs.existsSync(target)).toBe(false);
        if (nested) {
          expect(fs.existsSync(parent)).toBe(false);
        }
        expect(fs.readdirSync(dir)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("accepts a note of exactly 500 characters (boundary control)", async () => {
    const dir = freshDir();
    const target = path.join(dir, "selection.json");
    const file: SelectionFile = {
      version: 1,
      entries: [
        {
          screen: SCREENS[0],
          direction: STYLE_DIRECTIONS[0],
          index: REF_INDICES[0],
          verdict: "keep",
          note: "x".repeat(SELECTION_NOTE_MAX_LENGTH),
        },
      ],
    };
    await writeSelection(target, file);
    expect(fs.existsSync(target)).toBe(true);
  });
});
