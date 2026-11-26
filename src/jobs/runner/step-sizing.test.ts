import { describe, expect, it } from "vitest";
import {
  MAX_STEP_REPLY_TOKENS,
  capStepReplyTokens,
  fitsProxyCap,
  splitStepEstimate,
} from "./step-sizing.js";

describe("step sizing (Req 6.5)", () => {
  it("uses the 64,000 token Proxy cap", () => {
    expect(MAX_STEP_REPLY_TOKENS).toBe(64_000);
  });

  it("caps and checks estimates at the boundary", () => {
    expect(fitsProxyCap(64_000)).toBe(true);
    expect(fitsProxyCap(64_001)).toBe(false);
    expect(capStepReplyTokens(64_001)).toBe(64_000);
    expect(capStepReplyTokens(-3)).toBe(0);
    expect(capStepReplyTokens(10.2)).toBe(11);
  });

  it("splits an oversize estimate into the fewest even parts under the cap", () => {
    expect(splitStepEstimate(64_000)).toEqual([64_000]);
    expect(splitStepEstimate(64_001)).toEqual([32_001, 32_000]);
    const parts = splitStepEstimate(200_000);
    expect(parts).toHaveLength(4);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(200_000);
    expect(Math.max(...parts)).toBeLessThanOrEqual(MAX_STEP_REPLY_TOKENS);
  });

  it("returns one empty Step for zero and rejects non-finite input", () => {
    expect(splitStepEstimate(0)).toEqual([0]);
    expect(() => splitStepEstimate(Number.NaN)).toThrow(RangeError);
    expect(() => splitStepEstimate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
