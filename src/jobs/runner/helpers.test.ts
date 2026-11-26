import { describe, expect, it } from "vitest";
import {
  buildStepInput,
  checkBudget,
  isEmptyReply,
  nextBackoffMs,
  pickFallbackModel,
  validateTimeoutSeconds,
} from "./helpers.js";

describe("buildStepInput", () => {
  it("keeps only progress and upstream task results", () => {
    const upstream = [{ taskId: "t1", result: "ok", transcript: ["secret"] }];
    const input = buildStepInput("# progress", upstream);
    expect(input).toEqual({ progress: "# progress", upstream: [{ taskId: "t1", result: "ok" }] });
    expect(JSON.stringify(input)).not.toContain("secret");
  });
});

describe("nextBackoffMs", () => {
  it("doubles from 2s and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100, 1e9].map(nextBackoffMs)).toEqual([
      2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000,
    ]);
  });
  it("treats invalid attempts as the first attempt", () => {
    expect(nextBackoffMs(0)).toBe(2000);
    expect(nextBackoffMs(Number.NaN)).toBe(2000);
  });
});

describe("isEmptyReply", () => {
  it("flags empty and whitespace-only replies", () => {
    expect(isEmptyReply("")).toBe(true);
    expect(isEmptyReply(" \n\t ")).toBe(true);
    expect(isEmptyReply("hi")).toBe(false);
  });
});

describe("pickFallbackModel", () => {
  const list = ["a", "b", "c"];
  it("returns the next untried model in list order", () => {
    expect(pickFallbackModel([], list)).toBe("a");
    expect(pickFallbackModel(["a"], list)).toBe("b");
    expect(pickFallbackModel(["b", "a"], list)).toBe("c");
  });
  it("returns exhausted when all models were tried or the list is empty", () => {
    expect(pickFallbackModel(["a", "b", "c"], list)).toBe("exhausted");
    expect(pickFallbackModel([], [])).toBe("exhausted");
  });
});

describe("validateTimeoutSeconds", () => {
  it("accepts integers from 1 to 86400", () => {
    expect(validateTimeoutSeconds(1)).toEqual({ value: 1, usedDefault: false });
    expect(validateTimeoutSeconds(86_400)).toEqual({ value: 86_400, usedDefault: false });
  });
  it("falls back to 600 for missing, non-integer or out-of-range values", () => {
    for (const bad of [undefined, null, "30", 1.5, 0, -1, 86_401, Number.NaN, Infinity]) {
      expect(validateTimeoutSeconds(bad)).toEqual({ value: 600, usedDefault: true });
    }
  });
});

describe("checkBudget", () => {
  const budget = { tokens: 100, wallClockMs: 1000, toolCalls: 10 };
  it("reports no dimension when usage is within every limit", () => {
    expect(checkBudget({ tokens: 100, wallClockMs: 1000, toolCalls: 10 }, budget)).toEqual({
      exceeded: null,
    });
  });
  it("names the single exceeded dimension", () => {
    expect(checkBudget({ tokens: 101, wallClockMs: 0, toolCalls: 0 }, budget).exceeded).toBe(
      "tokens",
    );
    expect(checkBudget({ tokens: 0, wallClockMs: 1001, toolCalls: 0 }, budget).exceeded).toBe(
      "wallClockMs",
    );
    expect(checkBudget({ tokens: 0, wallClockMs: 0, toolCalls: 11 }, budget).exceeded).toBe(
      "toolCalls",
    );
  });
});
