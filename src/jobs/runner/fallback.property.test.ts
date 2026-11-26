import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pickFallbackModel } from "./helpers.js";

// Feature: friday-design-orchestrator-harness, Property 26: Model fallback progression
// **Validates: Requirements 6.9**

// Small alphabet so tried/fallback lists overlap often (including duplicates and unlisted tried models).
const modelId = fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h");
const modelList = fc.array(modelId, { maxLength: 8 });

describe("Feature: friday-design-orchestrator-harness, Property 26: Model fallback progression", () => {
  it("returns the first list model, in list order, that has not been tried", () => {
    fc.assert(
      fc.property(modelList, modelList, (tried, list) => {
        const result = pickFallbackModel(tried, list);
        const expected = list.find((m) => !tried.includes(m));
        if (expected === undefined) {
          expect(result).toBe("exhausted");
        } else {
          expect(result).toBe(expected);
          // Every model listed before the pick has already been tried.
          const idx = list.indexOf(result);
          for (const earlier of list.slice(0, idx)) {
            expect(tried).toContain(earlier);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('returns "exhausted" iff every list model has been tried (or the list is empty)', () => {
    fc.assert(
      fc.property(modelList, modelList, (tried, list) => {
        const allTried = list.every((m) => tried.includes(m));
        expect(pickFallbackModel(tried, list) === "exhausted").toBe(allTried);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(modelList, (tried) => {
        expect(pickFallbackModel(tried, [])).toBe("exhausted");
      }),
      { numRuns: 100 },
    );
  });

  it("returns a member of the list that was not tried whenever it is not exhausted", () => {
    fc.assert(
      fc.property(modelList, modelList, (tried, list) => {
        const result = pickFallbackModel(tried, list);
        if (result !== "exhausted") {
          expect(list).toContain(result);
          expect(tried).not.toContain(result);
        }
      }),
      { numRuns: 100 },
    );
  });
});
