import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyStepForRouting,
  orderFallbackList,
  SLOW_MODEL_LATENCY_MS,
  type ModelLatency,
  type StepKind,
} from "./router.js";
// Feature: friday-design-orchestrator-harness, Property 43: Router model selection and fallback ordering
// **Validates: Requirements 10.5, 10.6**

const stepKindArb: fc.Arbitrary<StepKind> = fc.constantFrom<StepKind>(
  "plan",
  "verify",
  "low-complexity",
  "normal",
);

/** Latencies cluster around the 30000ms threshold so both sides and the boundary are hit often. */
const latencyArb = fc.oneof(
  fc.integer({ min: 0, max: 60_000 }),
  fc.integer({ min: SLOW_MODEL_LATENCY_MS - 3, max: SLOW_MODEL_LATENCY_MS + 3 }),
);

/** Unique ids so each id maps to exactly one model and order can be checked by id. */
const modelsArb: fc.Arbitrary<ModelLatency[]> = fc.uniqueArray(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    medianLatencyMs: latencyArb,
  }),
  { selector: (m) => m.id, maxLength: 20 },
);

describe("Feature: friday-design-orchestrator-harness, Property 43: Router model selection and fallback ordering", () => {
  it("routes low-complexity Steps to the fast model and plan/verify/normal Steps to the main model", () => {
    fc.assert(
      fc.property(stepKindArb, (kind) => {
        const expected = kind === "low-complexity" ? "fast" : "main";
        expect(classifyStepForRouting({ kind })).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("returns a permutation of the input ids", () => {
    fc.assert(
      fc.property(modelsArb, (models) => {
        const ordered = orderFallbackList(models);
        expect([...ordered].toSorted()).toEqual(models.map((m) => m.id).toSorted());
      }),
      { numRuns: 200 },
    );
  });

  it("places every model under 30000ms before every model at or above 30000ms, stable within each group", () => {
    fc.assert(
      fc.property(modelsArb, (models) => {
        const ordered = orderFallbackList(models);
        const latencyById = new Map(models.map((m) => [m.id, m.medianLatencyMs]));
        const isFast = (id: string) => (latencyById.get(id) as number) < SLOW_MODEL_LATENCY_MS;

        // Group split: once a slow model appears, no fast model may follow.
        const firstSlow = ordered.findIndex((id) => !isFast(id));
        if (firstSlow !== -1) {
          expect(ordered.slice(firstSlow).some(isFast)).toBe(false);
        }

        // Stability: each group keeps the relative order it had in the input.
        const inputIds = models.map((m) => m.id);
        expect(ordered.filter(isFast)).toEqual(inputIds.filter(isFast));
        expect(ordered.filter((id) => !isFast(id))).toEqual(inputIds.filter((id) => !isFast(id)));
      }),
      { numRuns: 200 },
    );
  });
});
