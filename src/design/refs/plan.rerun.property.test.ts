import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  entriesToGenerate,
  planCombinations,
  type Manifest,
  type ManifestEntry,
  type RefStatus,
} from "./plan.js";

const key = (c: { screen: string; direction: string; index: number }) =>
  `${c.screen}/${c.direction}/${c.index}`;

const STATUSES: RefStatus[] = ["pending", "created", "failed"];

// For each of the 18 combinations: absent from the manifest, or present with any status.
// Manifest entry order is shuffled separately so the result must not depend on it.
const manifestArb: fc.Arbitrary<Manifest> = fc
  .tuple(
    fc.array(fc.option(fc.constantFrom(...STATUSES), { nil: undefined }), {
      minLength: 18,
      maxLength: 18,
    }),
    fc.shuffledSubarray(Array.from({ length: 18 }, (_, i) => i), { minLength: 18, maxLength: 18 }),
  )
  .map(([statuses, order]) => {
    const combos = planCombinations();
    const entries: ManifestEntry[] = [];
    for (const i of order) {
      const status = statuses[i];
      if (status !== undefined) {
        entries.push({ ...combos[i], status });
      }
    }
    return { version: 1, entries };
  });

describe("entriesToGenerate properties", () => {
  // Feature: friday-design-orchestrator-harness, Property 7: Rerun selection respects manifest status
  // **Validates: Requirements 1.13, 1.14**
  it("Feature: friday-design-orchestrator-harness, Property 7: without regenerate, returns exactly the missing, pending and failed entries", () => {
    fc.assert(
      fc.property(manifestArb, (manifest) => {
        const statusByKey = new Map(manifest.entries.map((e) => [key(e), e.status]));
        const expectedKeys = planCombinations()
          .filter((c) => {
            const status = statusByKey.get(key(c));
            // Missing from the manifest, pending, or failed all need generation.
            return status === undefined || status !== "created";
          })
          .map(key);

        const result = entriesToGenerate(manifest, false);
        const resultKeys = result.map(key);

        // Exactly the expected set, no duplicates, none of them already created.
        expect(new Set(resultKeys).size).toBe(resultKeys.length);
        expect([...resultKeys].toSorted()).toEqual([...expectedKeys].toSorted());
        for (const entry of result) {
          expect(statusByKey.get(key(entry))).not.toBe("created");
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: friday-design-orchestrator-harness, Property 7: Rerun selection respects manifest status
  // **Validates: Requirements 1.13, 1.14**
  it("Feature: friday-design-orchestrator-harness, Property 7: with regenerate, returns all 18 entries regardless of status", () => {
    fc.assert(
      fc.property(manifestArb, (manifest) => {
        const result = entriesToGenerate(manifest, true);
        expect(result).toHaveLength(18);
        expect(result.map(key).toSorted()).toEqual(planCombinations().map(key).toSorted());
      }),
      { numRuns: 100 },
    );
  });
});
