import { describe, expect, it, vi } from "vitest";

import { createTruncationGuardExtension } from "./session-resources.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadGuard(onBlocked?: () => void) {
  const handlers = new Map<string, Handler>();
  const ext = createTruncationGuardExtension(onBlocked) as {
    factory: (pi: { on: (name: string, fn: Handler) => void }) => void;
  };
  ext.factory({ on: (name, fn) => handlers.set(name, fn) });
  return handlers.get("session_before_compact")!;
}

const branch = (stopReason: string) => [
  { type: "message", message: { role: "user" } },
  { type: "message", message: { role: "assistant", stopReason } },
];
const ctx = (tokens: number | null, contextWindow = 1_000_000) => ({
  getContextUsage: () => ({ tokens, contextWindow, percent: null }),
});

describe("truncation guard", () => {
  it("cancels overflow compaction after a length stop with plenty of context left", () => {
    const blocked = vi.fn();
    const guard = loadGuard(blocked);
    const result = guard({ reason: "overflow", branchEntries: branch("length") }, ctx(73_000));
    expect(result).toEqual({ cancel: true });
    expect(blocked).toHaveBeenCalledOnce();
  });

  it("allows compaction when the context really is nearly full", () => {
    const guard = loadGuard();
    expect(
      guard({ reason: "overflow", branchEntries: branch("length") }, ctx(900_000)),
    ).toBeUndefined();
  });

  it("leaves error-overflow and threshold compactions alone", () => {
    const guard = loadGuard();
    expect(guard({ reason: "overflow", branchEntries: branch("error") }, ctx(10))).toBeUndefined();
    expect(
      guard({ reason: "threshold", branchEntries: branch("length") }, ctx(10)),
    ).toBeUndefined();
  });
});
