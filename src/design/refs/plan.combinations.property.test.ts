import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planCombinations, REF_INDICES, SCREENS, STYLE_DIRECTIONS } from "./plan.js";

const key = (c: { screen: string; direction: string; index: number }) =>
  `${c.screen}/${c.direction}/${c.index}`;

describe("planCombinations properties", () => {
  // Feature: friday-design-orchestrator-harness, Property 1: Reference combination plan is complete and unique
  // **Validates: Requirements 1.1**
  it("Feature: friday-design-orchestrator-harness, Property 1: plan has exactly one entry per (screen, direction, index), no duplicates or omissions", () => {
    // planCombinations() takes no input, so the generated value is the number of
    // repeated calls; every call must yield the same complete and unique plan.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (calls) => {
        const expected = new Set<string>();
        for (const screen of SCREENS) {
          for (const direction of STYLE_DIRECTIONS) {
            for (const index of REF_INDICES) {
              expected.add(`${screen}/${direction}/${index}`);
            }
          }
        }

        for (let i = 0; i < calls; i += 1) {
          const plan = planCombinations();
          const keys = plan.map(key);
          // 3 screens x 3 directions x 2 indices = 18, no duplicates.
          expect(plan).toHaveLength(18);
          expect(new Set(keys).size).toBe(keys.length);
          // No omissions and no extras.
          expect(new Set(keys)).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  });
});
