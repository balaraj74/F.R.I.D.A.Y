import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyLoopConfig, validateLoopConfig, type LoopConfig } from "./loop-detector.js";

// Feature: friday-design-orchestrator-harness, Property 42: Loop detector config validation keeps prior values
// **Validates: Requirements 10.10**

type Field = keyof LoopConfig;
const FIELDS: readonly Field[] = ["repeatThreshold", "windowSize", "similarityThreshold"];
const RUNS = { numRuns: 200 };

const validRepeat = fc.integer({ min: 2, max: 20 });
const validWindow = fc.integer({ min: 3, max: 100 });
const validSimilarity = fc.double({ min: 0.5, max: 1, noNaN: true });

const validConfig: fc.Arbitrary<LoopConfig> = fc.record({
  repeatThreshold: validRepeat,
  windowSize: validWindow,
  similarityThreshold: validSimilarity,
});

/** Values that are never acceptable for an integer field bounded by [min, max]. */
function invalidInteger(min: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: min - 1000, max: min - 1 }),
    fc.integer({ min: max + 1, max: max + 1000 }),
    fc.double({ min, max, noNaN: true }).filter((n) => !Number.isInteger(n)),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  );
}

const invalidSimilarity: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -1000, max: 0.5, maxExcluded: true, noNaN: true }),
  fc.double({ min: 1, max: 1000, minExcluded: true, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

const invalidValue: Record<Field, fc.Arbitrary<number>> = {
  repeatThreshold: invalidInteger(2, 20),
  windowSize: invalidInteger(3, 100),
  similarityThreshold: invalidSimilarity,
};

/** A config that is valid except for one field, with that field's name. */
const singleFaultConfig = fc
  .tuple(validConfig, fc.constantFrom(...FIELDS))
  .chain(([base, field]) =>
    invalidValue[field].map((bad) => ({ field, config: { ...base, [field]: bad } as LoopConfig })),
  );

/** Independent oracle for the Req 10.10 ranges. */
function isInRange(field: Field, value: number): boolean {
  switch (field) {
    case "repeatThreshold":
      return Number.isInteger(value) && value >= 2 && value <= 20;
    case "windowSize":
      return Number.isInteger(value) && value >= 3 && value <= 100;
    case "similarityThreshold":
      return value >= 0.5 && value <= 1;
  }
}

const anyNumber = fc.oneof(
  fc.integer({ min: -10, max: 120 }),
  fc.double({ min: -10, max: 120 }),
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.5,
    1,
    2,
    20,
    3,
    100,
  ),
);

describe("Property 42: Loop detector config validation keeps prior values", () => {
  it("accepts every config whose fields are all in range", () => {
    fc.assert(
      fc.property(validConfig, (cfg) => {
        const result = validateLoopConfig(cfg);
        expect(result.ok).toBe(true);
        expect(result.invalidField).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("accepts the range boundaries exactly", () => {
    for (const repeatThreshold of [2, 20]) {
      for (const windowSize of [3, 100]) {
        for (const similarityThreshold of [0.5, 1]) {
          expect(validateLoopConfig({ repeatThreshold, windowSize, similarityThreshold }).ok).toBe(
            true,
          );
        }
      }
    }
  });

  it("accepts iff every field is in range, for arbitrary numeric values", () => {
    fc.assert(
      fc.property(
        anyNumber,
        anyNumber,
        anyNumber,
        (repeatThreshold, windowSize, similarityThreshold) => {
          const cfg: LoopConfig = { repeatThreshold, windowSize, similarityThreshold };
          const expectedFaults = FIELDS.filter((f) => !isInRange(f, cfg[f]));
          const result = validateLoopConfig(cfg);
          expect(result.ok).toBe(expectedFaults.length === 0);
          if (expectedFaults.length === 0) {
            expect(result.invalidField).toBeUndefined();
          } else {
            // The reported field is one of the genuinely invalid fields.
            expect(expectedFaults).toContain(result.invalidField);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("rejects a config with one bad field and names exactly that field", () => {
    fc.assert(
      fc.property(singleFaultConfig, ({ field, config }) => {
        const result = validateLoopConfig(config);
        expect(result.ok).toBe(false);
        expect(result.invalidField).toBe(field);
      }),
      RUNS,
    );
  });

  it("applyLoopConfig keeps the previous config unchanged when the proposal is rejected", () => {
    fc.assert(
      fc.property(validConfig, singleFaultConfig, (current, { field, config }) => {
        const before = { ...current };
        const result = applyLoopConfig(current, config);
        expect(result.ok).toBe(false);
        expect(result.invalidField).toBe(field);
        expect(result.error).toContain(field);
        expect(result.config).toBe(current);
        expect(result.config).toEqual(before);
        expect(current).toEqual(before);
      }),
      RUNS,
    );
  });

  it("applyLoopConfig adopts the proposal (as a copy) when it is valid", () => {
    fc.assert(
      fc.property(validConfig, validConfig, (current, proposed) => {
        const result = applyLoopConfig(current, proposed);
        expect(result.ok).toBe(true);
        expect(result.invalidField).toBeUndefined();
        expect(result.config).toEqual(proposed);
      }),
      RUNS,
    );
  });
});
