import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_STEP_REPLY_TOKENS,
  capStepReplyTokens,
  fitsProxyCap,
  splitStepEstimate,
} from "../runner/step-sizing.js";
import { MAX_STEPS_PER_TASK, parsePlanOutput, sizeTaskSteps } from "./plan-parse.js";
import { ROLES } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 24: Planner step sizing stays under the Proxy cap
// **Validates: Requirements 6.5**

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Positive whole-token estimates, from tiny through many Steps, biased to cap boundaries. */
const maxEstimate = MAX_STEP_REPLY_TOKENS * MAX_STEPS_PER_TASK;
const estimateArb = fc.oneof(
  fc.integer({ min: 1, max: maxEstimate }),
  fc
    .integer({ min: 1, max: 5 })
    .chain((k) =>
      fc.integer({ min: -2, max: 2 }).map((d) => Math.max(k * MAX_STEP_REPLY_TOKENS + d, 1)),
    ),
);

describe("Property 24: Planner step sizing stays under the Proxy cap", () => {
  it("splitStepEstimate yields steps <= cap, summing to the estimate, none empty", () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        const steps = splitStepEstimate(estimate);
        expect(steps.length).toBeGreaterThan(0);
        for (const step of steps) {
          expect(Number.isInteger(step)).toBe(true);
          expect(step).toBeGreaterThan(0);
          expect(step).toBeLessThanOrEqual(MAX_STEP_REPLY_TOKENS);
        }
        expect(sum(steps)).toBe(estimate);
      }),
      { numRuns: 200 },
    );
  });

  it("splits fractional estimates by rounding up, still under the cap", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: maxEstimate, noNaN: true }), (estimate) => {
        const steps = splitStepEstimate(estimate);
        expect(sum(steps)).toBe(Math.ceil(estimate));
        for (const step of steps) {
          expect(step).toBeGreaterThan(0);
          expect(step).toBeLessThanOrEqual(MAX_STEP_REPLY_TOKENS);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("uses the fewest steps and fitsProxyCap/capStepReplyTokens agree with the cap", () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        expect(splitStepEstimate(estimate)).toHaveLength(
          Math.ceil(estimate / MAX_STEP_REPLY_TOKENS),
        );
        expect(fitsProxyCap(estimate)).toBe(estimate <= MAX_STEP_REPLY_TOKENS);
        const capped = capStepReplyTokens(estimate);
        expect(capped).toBeLessThanOrEqual(MAX_STEP_REPLY_TOKENS);
        expect(capped).toBe(Math.min(estimate, MAX_STEP_REPLY_TOKENS));
      }),
      { numRuns: 200 },
    );
  });

  it("sizeTaskSteps numbers steps from 1 and keeps each under the cap", () => {
    fc.assert(
      fc.property(estimateArb, (estimate) => {
        const steps = sizeTaskSteps(estimate);
        expect(steps.map((s) => s.index)).toEqual(steps.map((_, i) => i + 1));
        expect(steps.every((s) => s.expectedReplyTokens > 0)).toBe(true);
        expect(steps.every((s) => s.expectedReplyTokens <= MAX_STEP_REPLY_TOKENS)).toBe(true);
        expect(sum(steps.map((s) => s.expectedReplyTokens))).toBe(estimate);
      }),
      { numRuns: 200 },
    );
  });

  it("parsePlanOutput gives every Task of a parsed plan steps under the cap that sum to its estimate", () => {
    const estimatesArb = fc.array(fc.integer({ min: 1, max: maxEstimate }), {
      minLength: 1,
      maxLength: 5,
    });
    fc.assert(
      fc.property(estimatesArb, fc.constantFrom(...ROLES), (estimates, role) => {
        const raw = estimates.map((estimatedReplyTokens, i) => ({
          id: `t${i}`,
          role,
          dependsOn: i === 0 ? [] : [`t${i - 1}`],
          acceptanceChecks: [{ type: "file_exists", path: "out.txt" }],
          estimatedReplyTokens,
        }));
        const parsed = parsePlanOutput(raw);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.tasks).toHaveLength(estimates.length);
        parsed.tasks.forEach((task, i) => {
          const sizes = task.steps.map((s) => s.expectedReplyTokens);
          expect(sizes.every((n) => n > 0 && n <= MAX_STEP_REPLY_TOKENS)).toBe(true);
          expect(sum(sizes)).toBe(estimates[i]);
        });
      }),
      { numRuns: 100 },
    );
  });
});
