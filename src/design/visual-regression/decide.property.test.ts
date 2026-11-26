import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideScreenshotResult } from "./decide.js";

// Feature: friday-design-orchestrator-harness, Property 16: Visual regression decision logic
// **Validates: Requirements 3.9, 3.10**

const pixelsArb = fc.integer({ min: 0, max: 10_000_000 });

describe("Feature: friday-design-orchestrator-harness, Property 16: Visual regression decision logic", () => {
  it("returns fail-missing-baseline whenever no baseline exists, regardless of other args", () => {
    fc.assert(
      fc.property(pixelsArb, pixelsArb, (diffPixels, aaTolerancePixels) => {
        expect(decideScreenshotResult(diffPixels, aaTolerancePixels, false)).toBe(
          "fail-missing-baseline",
        );
      }),
      { numRuns: 100 },
    );
  });

  it("with a baseline, returns pass iff diff pixels after tolerance are 0, else fail-diff", () => {
    fc.assert(
      fc.property(pixelsArb, pixelsArb, (diffPixels, aaTolerancePixels) => {
        const result = decideScreenshotResult(diffPixels, aaTolerancePixels, true);
        const remaining = diffPixels - aaTolerancePixels;
        expect(result).toBe(remaining > 0 ? "fail-diff" : "pass");
        expect(result).not.toBe("fail-missing-baseline");
      }),
      { numRuns: 100 },
    );
  });

  it("passes at or below the tolerance and fails one pixel above it", () => {
    fc.assert(
      fc.property(pixelsArb, fc.nat(1000), (aaTolerancePixels, below) => {
        const atOrBelow = Math.max(0, aaTolerancePixels - below);
        expect(decideScreenshotResult(atOrBelow, aaTolerancePixels, true)).toBe("pass");
        expect(decideScreenshotResult(aaTolerancePixels + 1, aaTolerancePixels, true)).toBe(
          "fail-diff",
        );
      }),
      { numRuns: 100 },
    );
  });

  it("passes with zero diff pixels and zero tolerance when a baseline exists", () => {
    expect(decideScreenshotResult(0, 0, true)).toBe("pass");
    expect(decideScreenshotResult(1, 0, true)).toBe("fail-diff");
    expect(decideScreenshotResult(0, 0, false)).toBe("fail-missing-baseline");
  });
});
