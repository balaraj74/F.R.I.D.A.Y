import { describe, expect, it } from "vitest";

import { importanceOf, recencyOf, rerankHits, RECENCY_HALF_LIFE_DAYS } from "./rerank.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22);

describe("memory rerank", () => {
  it("weights curated memory above notes above transcripts", () => {
    expect(importanceOf({ path: "MEMORY.md", source: "memory" })).toBe(1);
    expect(importanceOf({ path: "memory/2026-09-18.md", source: "memory" })).toBe(0.6);
    expect(importanceOf({ path: "sessions/abc.jsonl", source: "sessions" })).toBe(0.3);
  });

  it("halves recency every half-life", () => {
    expect(recencyOf(NOW, NOW)).toBe(1);
    expect(recencyOf(NOW - RECENCY_HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.5);
    expect(recencyOf(undefined, NOW)).toBe(0);
  });

  it("prefers the recent memory between two equally relevant hits", () => {
    const hits = [
      { path: "sessions/old.jsonl", source: "sessions", score: 0.5 },
      { path: "sessions/new.jsonl", source: "sessions", score: 0.5 },
    ];
    const mtimes: Record<string, number> = {
      "sessions/old.jsonl": NOW - 200 * DAY,
      "sessions/new.jsonl": NOW - 1 * DAY,
    };
    const ranked = rerankHits(hits, (p) => mtimes[p], NOW);
    expect(ranked.map((h) => h.path)).toEqual(["sessions/new.jsonl", "sessions/old.jsonl"]);
    expect(ranked[0].updatedAt).toBe(mtimes["sessions/new.jsonl"]);
  });

  it("keeps a clearly more relevant hit first despite age", () => {
    const ranked = rerankHits(
      [
        { path: "sessions/new.jsonl", source: "sessions", score: 0.3 },
        { path: "MEMORY.md", source: "memory", score: 0.6 },
      ],
      (p) => (p === "MEMORY.md" ? NOW - 365 * DAY : NOW),
      NOW,
    );
    expect(ranked[0].path).toBe("MEMORY.md");
  });
});
