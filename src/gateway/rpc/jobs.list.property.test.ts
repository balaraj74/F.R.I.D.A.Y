// Jobs_API list pagination property test (Requirement 11.4). The Event_Log is in memory.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { appendEvent, EVENT_TYPES, openEventLog } from "../../jobs/store/index.js";
import { LIST_PAGE_MAX, listJobs, type JobsApiDeps } from "./jobs.js";

// Feature: friday-design-orchestrator-harness, Property 46: Jobs_API list pagination and ordering
// **Validates: Requirements 11.4**

type Seed = { id: string; createdAtMs: number };

/** Writes one `job-created` event per seed into a fresh in-memory Event_Log. */
function depsWith(seeds: Seed[]): JobsApiDeps {
  const db = openEventLog(":memory:");
  for (const s of seeds) {
    appendEvent(db, {
      jobId: s.id,
      type: EVENT_TYPES.jobCreated,
      payload: { goal: "g" },
      createdAtMs: s.createdAtMs,
    });
  }
  return {
    db,
    createJob: async () => ({ id: "unused" }),
    pause: () => undefined,
    resume: () => undefined,
    cancel: () => undefined,
  };
}

/** Newest first; equal timestamps order by id, larger id first (the order listJobs documents). */
function expectedOrder(seeds: Seed[]): string[] {
  return [...seeds]
    .sort((a, b) =>
      a.createdAtMs !== b.createdAtMs
        ? b.createdAtMs - a.createdAtMs
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
    )
    .map((s) => s.id);
}

/** Follows nextCursor to the end, checking each page on the way. */
function walk(deps: JobsApiDeps, limit: number | undefined): string[] {
  const effective = limit ?? LIST_PAGE_MAX;
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const res = listJobs(deps, {
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("listJobs failed");
    const { jobs, hasMore, nextCursor } = res.value;
    expect(jobs.length).toBeLessThanOrEqual(Math.min(effective, LIST_PAGE_MAX));
    seen.push(...jobs.map((j) => j.id));
    if (hasMore) {
      // A page that reports more must be full, and must say where to continue.
      expect(jobs.length).toBe(effective);
      expect(nextCursor).toBeTypeOf("string");
      cursor = nextCursor;
    } else {
      expect(nextCursor).toBeUndefined();
      return seen;
    }
  }
  throw new Error("pagination did not terminate");
}

/** Timestamps from a narrow range so many Jobs share a millisecond and exercise the id tiebreak. */
const seedsArb: fc.Arbitrary<Seed[]> = fc
  // Half the runs straddle the 100-job page cap so multi-page walks are always covered.
  .oneof(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 95, max: 260 }))
  .chain((count) =>
    fc.tuple(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
        minLength: count,
        maxLength: count,
      }),
      fc.array(fc.integer({ min: 0, max: 30 }), { minLength: count, maxLength: count }),
    ),
  )
  .map(([ids, times]) => ids.map((id, i) => ({ id, createdAtMs: times[i] ?? 0 })));

describe("Feature: friday-design-orchestrator-harness, Property 46: Jobs_API list pagination and ordering", () => {
  it("pages through every job once, newest first, at most 100 per page", () => {
    fc.assert(
      fc.property(seedsArb, (seeds) => {
        const deps = depsWith(seeds);
        const want = expectedOrder(seeds);

        // The first page without a limit holds at most 100 jobs and is the newest prefix.
        const first = listJobs(deps);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.value.jobs.map((j) => j.id)).toEqual(want.slice(0, LIST_PAGE_MAX));
        expect(first.value.hasMore).toBe(seeds.length > LIST_PAGE_MAX);

        // Following cursors yields every job exactly once, in order: no duplicates, no gaps.
        const seen = walk(deps, undefined);
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toEqual(want);
      }),
      { numRuns: 40 },
    );
  });

  it("honours any custom limit from 1 to 100 and keeps the same order across pages", () => {
    fc.assert(
      fc.property(seedsArb, fc.integer({ min: 1, max: LIST_PAGE_MAX }), (seeds, limit) => {
        const deps = depsWith(seeds);
        const want = expectedOrder(seeds);
        const first = listJobs(deps, { limit });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.value.jobs).toHaveLength(Math.min(limit, seeds.length));
        expect(first.value.hasMore).toBe(seeds.length > limit);
        expect(walk(deps, limit)).toEqual(want);
      }),
      { numRuns: 40 },
    );
  });

  it("returns an empty, final page when there are no jobs", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: LIST_PAGE_MAX }), { nil: undefined }),
        (limit) => {
          const res = listJobs(depsWith([]), limit === undefined ? {} : { limit });
          expect(res).toEqual({ ok: true, value: { jobs: [], hasMore: false } });
        },
      ),
      { numRuns: 20 },
    );
  });
});
