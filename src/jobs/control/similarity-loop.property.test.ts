import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { detectPlanSimilarityLoop, planSimilarity } from "./loop-detector.js";

// Feature: friday-design-orchestrator-harness, Property 40: Plan similarity loop detection
// For any new plan and list of prior plans, detectPlanSimilarityLoop flags a loop iff the
// similarity score between the new plan and at least one prior plan is at or above the threshold.
// **Validates: Requirements 10.2**

// Plans are built from a small word pool so generated pairs often overlap (scores spread across
// [0,1] instead of clustering at 0), plus arbitrary strings for punctuation/empty/unicode input.
const word = fc.constantFrom(
  "read",
  "write",
  "test",
  "lint",
  "fix",
  "Plan",
  "step",
  "file",
  "a_1",
  "é",
);
const wordPlan = fc.array(word, { maxLength: 12 }).map((words) => words.join(" "));
const plan = fc.oneof(wordPlan, fc.string({ unit: "binary", maxLength: 40 }));

// similarityThreshold is valid in 0.50..1.00 (Req 10.10); include the 1.00 boundary explicitly.
const threshold = fc.oneof(
  fc.double({ min: 0.5, max: 1, noNaN: true }),
  fc.constantFrom(0.5, 0.85, 1),
);

describe("Feature: friday-design-orchestrator-harness, Property 40: Plan similarity loop detection", () => {
  // **Validates: Requirements 10.2**
  it("identical plans score 1 and are flagged for any threshold in 0.50..1.00", () => {
    fc.assert(
      fc.property(plan, threshold, (p, t) => {
        expect(planSimilarity(p, p)).toBe(1);
        expect(detectPlanSimilarityLoop(p, [p], t)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 10.2**
  it("similarity is symmetric and within [0, 1]", () => {
    fc.assert(
      fc.property(plan, plan, (a, b) => {
        const score = planSimilarity(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
        expect(planSimilarity(b, a)).toBe(score);
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 10.2**
  it("flags iff some prior plan scores at or above the threshold", () => {
    fc.assert(
      fc.property(plan, fc.array(plan, { maxLength: 8 }), threshold, (newPlan, priors, t) => {
        const expected = priors.some((prior) => planSimilarity(newPlan, prior) >= t);
        expect(detectPlanSimilarityLoop(newPlan, priors, t)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  // **Validates: Requirements 10.2**
  it("flags at a threshold equal to a prior plan's exact score and not just above it", () => {
    fc.assert(
      fc.property(plan, plan, (newPlan, prior) => {
        const score = planSimilarity(newPlan, prior);
        if (score < 0.5) {
          return; // outside the valid threshold range
        }
        expect(detectPlanSimilarityLoop(newPlan, [prior], score)).toBe(true);
        if (score < 1) {
          expect(detectPlanSimilarityLoop(newPlan, [prior], Math.min(1, score + 1e-9))).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  // **Validates: Requirements 10.2**
  it("never flags when the prior plan list is empty", () => {
    fc.assert(
      fc.property(plan, threshold, (newPlan, t) => {
        expect(detectPlanSimilarityLoop(newPlan, [], t)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("adding a prior plan never clears a flag (monotonic in the prior list)", () => {
    fc.assert(
      fc.property(
        plan,
        fc.array(plan, { maxLength: 6 }),
        plan,
        threshold,
        (n, priors, extra, t) => {
          if (detectPlanSimilarityLoop(n, priors, t)) {
            expect(detectPlanSimilarityLoop(n, [...priors, extra], t)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
