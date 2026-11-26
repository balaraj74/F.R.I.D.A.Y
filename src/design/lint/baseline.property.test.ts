import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideExit } from "./decide.js";

// Feature: friday-design-orchestrator-harness, Property 15: Baseline comparison exit code
// **Validates: Requirements 3.4, 3.5**

const countArb = fc.nat({ max: 1_000_000 });

describe("Property 15: Baseline comparison exit code", () => {
  it("exits 1 iff violationCount > baselineCount, otherwise 0", () => {
    fc.assert(
      fc.property(countArb, countArb, (violationCount, baselineCount) => {
        const { exitCode } = decideExit(violationCount, baselineCount);
        expect(exitCode).toBe(violationCount > baselineCount ? 1 : 0);
      }),
      { numRuns: 100 },
    );
  });

  it("exits 0 when the count equals the baseline", () => {
    fc.assert(
      fc.property(countArb, (n) => {
        expect(decideExit(n, n).exitCode).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("handles the zero boundary", () => {
    expect(decideExit(1, 0).exitCode).toBe(1);
    expect(decideExit(0, 0).exitCode).toBe(0);
  });
});
