import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkBudget, type Budget, type BudgetDimension } from "./helpers.js";

// Feature: friday-design-orchestrator-harness, Property 23: Budget enforcement names the exceeded dimension
// **Validates: Requirements 6.3, 6.4**

const DIMENSIONS: BudgetDimension[] = ["tokens", "wallClockMs", "toolCalls"];

/** Small range so usage lands exactly on, just under and just over a limit often. */
const countArb = fc.integer({ min: 0, max: 20 });
const budgetArb: fc.Arbitrary<Budget> = fc.record({
  tokens: countArb,
  wallClockMs: countArb,
  toolCalls: countArb,
});
const usageArb: fc.Arbitrary<Budget> = fc.record({
  tokens: countArb,
  wallClockMs: countArb,
  toolCalls: countArb,
});

describe("Feature: friday-design-orchestrator-harness, Property 23: Budget enforcement names the exceeded dimension", () => {
  it("reports null iff no dimension is strictly over its limit, else the first over-limit dimension", () => {
    fc.assert(
      fc.property(usageArb, budgetArb, (usage, budget) => {
        const over = DIMENSIONS.filter((d) => usage[d] > budget[d]);
        const { exceeded } = checkBudget(usage, budget);
        if (over.length === 0) {
          expect(exceeded).toBeNull();
        } else {
          expect(exceeded).not.toBeNull();
          expect(over).toContain(exceeded);
          // Ties are resolved in the order tokens, wallClockMs, toolCalls.
          expect(exceeded).toBe(over[0]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("names exactly the one dimension that is exceeded and no other", () => {
    fc.assert(
      fc.property(
        budgetArb,
        fc.constantFrom(...DIMENSIONS),
        fc.integer({ min: 1, max: 50 }),
        (budget, dimension, excess) => {
          // Every dimension sits at its limit (within budget) except one, which is over.
          const usage: Budget = { ...budget, [dimension]: budget[dimension] + excess };
          expect(checkBudget(usage, budget).exceeded).toBe(dimension);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("reports no exceeded dimension when usage is at or under every limit", () => {
    fc.assert(
      fc.property(budgetArb, fc.tuple(fc.nat(20), fc.nat(20), fc.nat(20)), (budget, slack) => {
        const usage: Budget = {
          tokens: Math.max(0, budget.tokens - slack[0]),
          wallClockMs: Math.max(0, budget.wallClockMs - slack[1]),
          toolCalls: Math.max(0, budget.toolCalls - slack[2]),
        };
        expect(checkBudget(usage, budget)).toEqual({ exceeded: null });
      }),
      { numRuns: 100 },
    );
  });
});
