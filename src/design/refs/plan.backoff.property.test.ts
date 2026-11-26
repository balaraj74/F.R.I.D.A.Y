import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  MAX_RETRIES,
  RESOURCE_EXHAUSTED_MIN_MS,
  nextBackoffMs,
} from "./plan.js";

// Feature: friday-design-orchestrator-harness, Property 3: Backoff delay formula
// **Validates: Requirements 1.3, 1.4**

/** Attempt numbers are 1-based and range over the 5 permitted retries. */
const attemptArb = fc.integer({ min: 1, max: MAX_RETRIES });
const MAX_DELAY_MS = BACKOFF_BASE_MS * 2 ** (MAX_RETRIES - 1); // 32s, the attempt-5 delay

describe("Feature: friday-design-orchestrator-harness, Property 3: Backoff delay formula", () => {
  it("equals 2000 * 2^(attempt-1) when not resource-exhausted", () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextBackoffMs(attempt, false)).toBe(2000 * 2 ** (attempt - 1));
      }),
      { numRuns: 100 },
    );
  });

  it("doubles after each failed attempt, starting at 2s", () => {
    expect(nextBackoffMs(1, false)).toBe(2000);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_RETRIES - 1 }), (attempt) => {
        expect(nextBackoffMs(attempt + 1, false)).toBe(2 * nextBackoffMs(attempt, false));
      }),
      { numRuns: 100 },
    );
  });

  it("returns exactly 2s, 4s, 8s, 16s, 32s for attempts 1 to 5", () => {
    expect([1, 2, 3, 4, 5].map((n) => nextBackoffMs(n, false))).toEqual([
      2000, 4000, 8000, 16000, 32000,
    ]);
  });

  it("is at least 30s when resource-exhausted, and equals max(formula, 30s)", () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        const delay = nextBackoffMs(attempt, true);
        expect(delay).toBeGreaterThanOrEqual(RESOURCE_EXHAUSTED_MIN_MS);
        expect(delay).toBe(Math.max(2000 * 2 ** (attempt - 1), RESOURCE_EXHAUSTED_MIN_MS));
      }),
      { numRuns: 100 },
    );
  });

  it("never returns a shorter delay for resource-exhausted than for a plain failure", () => {
    fc.assert(
      fc.property(attemptArb, (attempt) => {
        expect(nextBackoffMs(attempt, true)).toBeGreaterThanOrEqual(nextBackoffMs(attempt, false));
      }),
      { numRuns: 100 },
    );
  });

  it("stays within the 5-retry cap: attempts beyond 5 never exceed the attempt-5 delay", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), fc.boolean(), (attempt, exhausted) => {
        const delay = nextBackoffMs(attempt, exhausted);
        expect(delay).toBeLessThanOrEqual(Math.max(MAX_DELAY_MS, RESOURCE_EXHAUSTED_MIN_MS));
        if (attempt > MAX_RETRIES) {
          expect(delay).toBe(nextBackoffMs(MAX_RETRIES, exhausted));
        }
      }),
      { numRuns: 100 },
    );
  });
});
