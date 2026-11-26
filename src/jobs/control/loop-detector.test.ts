import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOP_CONFIG,
  applyLoopConfig,
  detectPlanSimilarityLoop,
  detectRepeatLoop,
  loopResponse,
  validateLoopConfig,
  type ToolCall,
} from "./loop-detector.js";

const call = (tool: string, args?: unknown): ToolCall => ({ tool, arguments: args });

describe("detectRepeatLoop", () => {
  it("flags more than the threshold of identical calls, not exactly the threshold", () => {
    const same = (n: number) => Array.from({ length: n }, () => call("read", { path: "a" }));
    expect(detectRepeatLoop(same(3), 10, 3)).toBe(false);
    expect(detectRepeatLoop(same(4), 10, 3)).toBe(true);
  });

  it("flags a synthetic repeating Task by the 10th Step with defaults (Req 10.9)", () => {
    const calls = Array.from({ length: 10 }, () => call("exec", { cmd: "ls" }));
    const { windowSize, repeatThreshold } = DEFAULT_LOOP_CONFIG;
    expect(detectRepeatLoop(calls, windowSize, repeatThreshold)).toBe(true);
  });

  it("ignores repeats that do not fit inside one window", () => {
    const a = call("t", 1);
    const fill = (n: number) => call("other", n); // unique filler calls
    // Four `a` calls, but spread so no 5-call window holds more than 2.
    const spread = [a, fill(1), fill(2), a, fill(3), fill(4), a, fill(5), fill(6), a];
    expect(detectRepeatLoop(spread, 5, 2)).toBe(false);
    expect(detectRepeatLoop([a, fill(1), a, fill(2), a], 5, 2)).toBe(true);
  });

  it("treats argument key order as irrelevant", () => {
    const calls = [call("t", { a: 1, b: 2 }), call("t", { b: 2, a: 1 }), call("t", { a: 1, b: 2 })];
    expect(detectRepeatLoop(calls, 3, 2)).toBe(true);
  });
});

describe("detectPlanSimilarityLoop", () => {
  it("flags at or above the threshold and not below it", () => {
    expect(detectPlanSimilarityLoop("run tests then fix", ["run tests then fix"], 1)).toBe(true);
    expect(detectPlanSimilarityLoop("alpha beta", ["gamma delta"], 0.5)).toBe(false);
    expect(detectPlanSimilarityLoop("a b c d", ["a b c x"], 0.75)).toBe(true);
    expect(detectPlanSimilarityLoop("a b c d", ["a b c x"], 0.76)).toBe(false);
  });

  it("returns false with no prior plans", () => {
    expect(detectPlanSimilarityLoop("anything", [], 0.5)).toBe(false);
  });
});

describe("validateLoopConfig / applyLoopConfig", () => {
  const ok = { repeatThreshold: 3, windowSize: 10, similarityThreshold: 0.85 };

  it("accepts boundary values and rejects just outside them", () => {
    expect(
      validateLoopConfig({ repeatThreshold: 2, windowSize: 3, similarityThreshold: 0.5 }).ok,
    ).toBe(true);
    expect(
      validateLoopConfig({ repeatThreshold: 20, windowSize: 100, similarityThreshold: 1 }).ok,
    ).toBe(true);
    expect(validateLoopConfig({ ...ok, repeatThreshold: 1 })).toEqual({
      ok: false,
      invalidField: "repeatThreshold",
    });
    expect(validateLoopConfig({ ...ok, repeatThreshold: 21 }).invalidField).toBe("repeatThreshold");
    expect(validateLoopConfig({ ...ok, windowSize: 2 }).invalidField).toBe("windowSize");
    expect(validateLoopConfig({ ...ok, windowSize: 101 }).invalidField).toBe("windowSize");
    expect(validateLoopConfig({ ...ok, similarityThreshold: 0.49 }).invalidField).toBe(
      "similarityThreshold",
    );
    expect(validateLoopConfig({ ...ok, similarityThreshold: 1.01 }).invalidField).toBe(
      "similarityThreshold",
    );
    expect(validateLoopConfig({ ...ok, windowSize: Number.NaN }).invalidField).toBe("windowSize");
  });

  it("keeps the previous values and names the field on rejection", () => {
    const rejected = applyLoopConfig(ok, { ...ok, windowSize: 500 });
    expect(rejected.ok).toBe(false);
    expect(rejected.config).toEqual(ok);
    expect(rejected.error).toContain("windowSize");
    const accepted = applyLoopConfig(ok, { ...ok, windowSize: 20 });
    expect(accepted.config.windowSize).toBe(20);
  });
});

describe("loopResponse", () => {
  it("changes approach on the first flag and fails the Task after a change was recorded", () => {
    expect(loopResponse([])).toBe("change-approach");
    expect(loopResponse([{ cause: "repeat" }])).toBe("change-approach");
    expect(
      loopResponse([{ cause: "repeat", response: "change-approach" }, { cause: "similarity" }]),
    ).toBe("fail-task");
  });
});
