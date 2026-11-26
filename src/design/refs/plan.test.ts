import { describe, expect, it } from "vitest";
import {
  entriesToGenerate,
  groupForGallery,
  nextBackoffMs,
  planCombinations,
  type Manifest,
} from "./plan.js";

describe("planCombinations", () => {
  it("returns 18 unique combinations", () => {
    const combos = planCombinations();
    expect(combos).toHaveLength(18);
    expect(new Set(combos.map((c) => `${c.screen}/${c.direction}/${c.index}`)).size).toBe(18);
  });
});

describe("nextBackoffMs", () => {
  it("doubles from 2s per attempt", () => {
    expect([1, 2, 3, 4, 5].map((n) => nextBackoffMs(n, false))).toEqual([
      2000, 4000, 8000, 16000, 32000,
    ]);
  });

  it("waits at least 30s on RESOURCE_EXHAUSTED", () => {
    expect(nextBackoffMs(1, true)).toBe(30_000);
    expect(nextBackoffMs(5, true)).toBe(32_000);
  });
});

describe("entriesToGenerate", () => {
  const manifest: Manifest = {
    version: 1,
    entries: [
      { screen: "home", direction: "glass", index: 0, status: "created", source: "image_generate" },
      { screen: "home", direction: "glass", index: 1, status: "failed", failureReason: "x" },
    ],
  };

  it("skips created entries and keeps failed and missing ones", () => {
    const todo = entriesToGenerate(manifest, false);
    expect(todo).toHaveLength(17);
    expect(todo.some((e) => e.screen === "home" && e.direction === "glass" && e.index === 0)).toBe(
      false,
    );
  });

  it("returns all 18 when regenerating", () => {
    expect(entriesToGenerate(manifest, true)).toHaveLength(18);
  });
});

describe("groupForGallery", () => {
  it("groups by screen then direction and omits pending entries", () => {
    const grouped = groupForGallery({
      version: 1,
      entries: [
        { screen: "chat", direction: "editorial", index: 1, status: "created" },
        { screen: "chat", direction: "editorial", index: 0, status: "failed" },
        { screen: "chat", direction: "editorial", index: 0, status: "pending" },
      ],
    });
    expect(grouped.chat.editorial.map((e) => e.status)).toEqual(["failed", "created"]);
    expect(grouped.home.glass).toEqual([]);
  });
});
