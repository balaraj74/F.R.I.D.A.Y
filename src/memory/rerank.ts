// Final ordering of memory search hits: relevance first, then nudged by how recent the source
// is and how deliberately it was saved. Applied only to hits that already passed the relevance
// threshold, so recency/importance can reorder relevant memories but never admit irrelevant ones.

export type RankableHit = {
  path: string;
  source: string;
  score: number;
};

export const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_WEIGHT = 0.2;
const IMPORTANCE_WEIGHT = 0.2;

/** Curated memory beats daily notes beats raw conversation transcripts. */
export function importanceOf(hit: { path: string; source: string }): number {
  const file = hit.path.split("/").pop() ?? hit.path;
  if (hit.source === "memory" && /^(MEMORY|USER)\.md$/i.test(file)) return 1;
  if (hit.source === "memory") return 0.6;
  return 0.3; // sessions
}

/** 1 for something touched now, 0.5 after one half-life, approaching 0 for old material. */
export function recencyOf(updatedAtMs: number | undefined, nowMs: number): number {
  if (!updatedAtMs || !Number.isFinite(updatedAtMs)) return 0;
  const ageDays = Math.max(0, nowMs - updatedAtMs) / 86_400_000;
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function rerankHits<T extends RankableHit>(
  hits: T[],
  updatedAt: (path: string) => number | undefined,
  nowMs = Date.now(),
): Array<T & { updatedAt?: number }> {
  return hits
    .map((hit) => {
      const ts = updatedAt(hit.path);
      const boost =
        1 + RECENCY_WEIGHT * recencyOf(ts, nowMs) + IMPORTANCE_WEIGHT * importanceOf(hit);
      return { ...hit, score: hit.score * boost, ...(ts ? { updatedAt: ts } : {}) };
    })
    .sort((a, b) => b.score - a.score);
}
