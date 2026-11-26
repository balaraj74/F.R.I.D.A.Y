import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateTimeoutSeconds } from "./helpers.js";

// Feature: friday-design-orchestrator-harness, Property 27: Step timeout validation
// **Validates: Requirements 6.11, 6.12**

const DEFAULT_RESULT = { value: 600, usedDefault: true };

/** Anything that is not a valid timeout: wrong type, non-integer, or out of range. */
const invalidArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.string(),
  fc.boolean(),
  fc.bigInt(),
  // Numeric strings must not be coerced, including ones that look valid.
  fc.integer({ min: 1, max: 86_400 }).map(String),
  fc.object(),
  fc.array(fc.integer()),
  // Non-integer finite numbers, including ones inside the valid range.
  fc.double({ min: 0.001, max: 100_000, noNaN: true }).filter((n) => !Number.isInteger(n)),
  // Integers below the minimum and above the maximum.
  fc.integer({ max: 0 }),
  fc.integer({ min: 86_401 }),
);

describe("Feature: friday-design-orchestrator-harness, Property 27: Step timeout validation", () => {
  it("returns integers from 1 to 86400 unchanged with usedDefault false", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 86_400 }), (n) => {
        expect(validateTimeoutSeconds(n)).toEqual({ value: n, usedDefault: false });
      }),
      { numRuns: 200 },
    );
  });

  it("returns 600 with usedDefault true for every other input", () => {
    fc.assert(
      fc.property(invalidArb, (input) => {
        expect(validateTimeoutSeconds(input)).toEqual(DEFAULT_RESULT);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts the boundaries and rejects values just outside them", () => {
    expect(validateTimeoutSeconds(1)).toEqual({ value: 1, usedDefault: false });
    expect(validateTimeoutSeconds(86_400)).toEqual({ value: 86_400, usedDefault: false });
    expect(validateTimeoutSeconds(0)).toEqual(DEFAULT_RESULT);
    expect(validateTimeoutSeconds(86_401)).toEqual(DEFAULT_RESULT);
  });
});
