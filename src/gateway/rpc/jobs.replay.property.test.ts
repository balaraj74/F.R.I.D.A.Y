// Feature: friday-design-orchestrator-harness, Property 45: Jobs_API replay orders by timestamp
// **Validates: Requirements 11.3**
//
// Events are appended in arbitrary order with arbitrary (often tied) timestamps, alongside
// events of other Jobs. `replayJob` must return exactly this Job's events, ascending by
// (createdAtMs, id), and the same output on every call.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { appendEvent, EVENT_TYPES, openEventLog } from "../../jobs/store/index.js";
import { replayJob, type JobsApiDeps } from "./jobs.js";

const TARGET = "job-target";
const OTHERS = ["job-other-a", "job-other-b", "ops:health"] as const;

type Spec = { owner: "target" | number; createdAtMs: number };

// A narrow range forces many ties; the wide range covers large and negative timestamps.
const timestamp = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 6 }) },
  { weight: 1, arbitrary: fc.integer({ min: -1_000_000, max: 2_000_000_000_000 }) },
);

const eventSpec: fc.Arbitrary<Spec> = fc.record({
  owner: fc.oneof(
    { weight: 3, arbitrary: fc.constant("target" as const) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: OTHERS.length - 1 }) },
  ),
  createdAtMs: timestamp,
});

/** In-memory Event_Log holding the target Job's created event plus `specs` in insertion order. */
function seed(specs: Spec[], createdAtMs: number) {
  const db = openEventLog(":memory:");
  const deps: JobsApiDeps = {
    db,
    createJob: async () => ({ id: TARGET }),
    pause: () => undefined,
    resume: () => undefined,
    cancel: () => undefined,
  };
  const targetIds: number[] = [];
  const created = appendEvent(db, {
    jobId: TARGET,
    type: EVENT_TYPES.jobCreated,
    payload: { goal: "g" },
    createdAtMs,
  });
  targetIds.push(created.id);
  const times = new Map<number, number>([[created.id, createdAtMs]]);
  specs.forEach((s, i) => {
    const jobId = s.owner === "target" ? TARGET : OTHERS[s.owner];
    const appended = appendEvent(db, {
      jobId: jobId ?? TARGET,
      type: "job.note",
      payload: { i },
      createdAtMs: s.createdAtMs,
    });
    if (jobId === TARGET) {
      targetIds.push(appended.id);
      times.set(appended.id, s.createdAtMs);
    }
  });
  return { deps, targetIds, times };
}

describe("Property 45: Jobs_API replay orders by timestamp", () => {
  it("returns exactly the job's events sorted ascending by (createdAtMs, id), identically on repeat", () => {
    fc.assert(
      fc.property(fc.array(eventSpec, { maxLength: 40 }), timestamp, (specs, createdAtMs) => {
        const { deps, targetIds, times } = seed(specs, createdAtMs);

        const first = replayJob(deps, { jobId: TARGET });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const events = first.value.events;

        // Exactly this Job's events, none from other Jobs, none missing or duplicated.
        expect(first.value.jobId).toBe(TARGET);
        expect(events.every((e) => e.jobId === TARGET)).toBe(true);
        expect(events.map((e) => e.seq).toSorted((a, b) => a - b)).toEqual(
          targetIds.toSorted((a, b) => a - b),
        );
        for (const e of events) expect(e.createdAtMs).toBe(times.get(e.seq));

        // Ascending by (createdAtMs, id), checked both pairwise and against an independent sort.
        for (let i = 1; i < events.length; i += 1) {
          const prev = events[i - 1];
          const cur = events[i];
          if (!prev || !cur) throw new Error("unreachable");
          expect(
            prev.createdAtMs < cur.createdAtMs ||
              (prev.createdAtMs === cur.createdAtMs && prev.seq < cur.seq),
          ).toBe(true);
        }
        const expected = targetIds.toSorted(
          (a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0) || a - b,
        );
        expect(events.map((e) => e.seq)).toEqual(expected);

        // Replaying again gives identical output.
        expect(replayJob(deps, { jobId: TARGET })).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });

  it("returns not_found for a job id with no events and for an ops-only log owner", () => {
    fc.assert(
      fc.property(fc.array(eventSpec, { maxLength: 15 }), timestamp, (specs, createdAtMs) => {
        const { deps } = seed(specs, createdAtMs);
        for (const jobId of ["job-missing", "ops:health", "job-other-a"]) {
          const res = replayJob(deps, { jobId });
          expect(res.ok).toBe(false);
          if (res.ok) continue;
          expect(res.error.code).toBe("not_found");
          expect(res.error.jobId).toBe(jobId);
        }
      }),
      { numRuns: 50 },
    );
  });
});
