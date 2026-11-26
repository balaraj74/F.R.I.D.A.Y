import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendEvent, EVENT_TYPES, loadEvents, openEventLog } from "../store/index.js";
import {
  reclaimStaleLeases,
  resetJobEngineRestoreForTests,
  restoreJobEngineOnce,
  type ResumeStepRequest,
} from "./boot.js";

// Feature: friday-design-orchestrator-harness, Property 19: Boot-time stale lease reclamation
// **Validates: Requirements 5.9**
// Also covers the "never re-executes a Step with a completion event" clause of Property 20.

type Db = ReturnType<typeof openEventLog>;

/** What a Step looks like in the log at boot time. */
type StepKind = "running" | "no-lease" | "completed" | "failed" | "reclaimed";

type StepSpec = {
  kind: StepKind;
  /** Lease expiry relative to boot time; negative or zero-adjacent values hit the boundary. */
  offsetMs: number;
  /** Optional heartbeat that replaces the original expiry (offset relative to boot time). */
  heartbeatOffsetMs?: number;
};

type Scenario = { bootTimeMs: number; jobs: StepSpec[][] };

const offsetArb = fc.oneof(
  fc.constantFrom(-1, 0, 1), // boundary: expiry == boot time is NOT stale
  fc.integer({ min: -5_000, max: 5_000 }),
);

const stepArb: fc.Arbitrary<StepSpec> = fc.record(
  {
    kind: fc.constantFrom<StepKind>("running", "no-lease", "completed", "failed", "reclaimed"),
    offsetMs: offsetArb,
    heartbeatOffsetMs: offsetArb,
  },
  { requiredKeys: ["kind", "offsetMs"] },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  bootTimeMs: fc.integer({ min: 10_000, max: 1_000_000_000 }),
  jobs: fc.array(fc.array(stepArb, { maxLength: 8 }), { minLength: 1, maxLength: 3 }),
});

const stepIdOf = (j: number, i: number) => `j${j}-s${i}`;
const jobIdOf = (j: number) => `job${j}`;

/** Effective lease expiry after any heartbeat, or undefined when the Step has no Lease. */
function expiryOf(spec: StepSpec, bootTimeMs: number): number | undefined {
  if (spec.kind === "no-lease") return undefined;
  return bootTimeMs + (spec.heartbeatOffsetMs ?? spec.offsetMs);
}

/** A Step is stale when it is still running with a Lease that expired before boot. */
function isStale(spec: StepSpec, bootTimeMs: number): boolean {
  if (spec.kind !== "running") return false;
  const expiry = expiryOf(spec, bootTimeMs);
  return expiry !== undefined && expiry < bootTimeMs;
}

function seed(db: Db, scenario: Scenario): void {
  let t = 1;
  const { bootTimeMs } = scenario;
  scenario.jobs.forEach((steps, j) => {
    const jobId = jobIdOf(j);
    appendEvent(db, { jobId, type: EVENT_TYPES.jobCreated, payload: {}, createdAtMs: t++ });
    appendEvent(db, {
      jobId,
      type: EVENT_TYPES.jobStateChanged,
      payload: { to: "running" },
      createdAtMs: t++,
    });
    steps.forEach((spec, i) => {
      const stepId = stepIdOf(j, i);
      const base = { jobId, taskId: `t-${stepId}`, stepId };
      const hasLease = spec.kind !== "no-lease";
      appendEvent(db, {
        ...base,
        type: EVENT_TYPES.stepStarted,
        payload: hasLease ? { leaseExpiresAtMs: bootTimeMs + spec.offsetMs } : {},
        createdAtMs: t++,
      });
      if (spec.kind === "running" && spec.heartbeatOffsetMs !== undefined) {
        appendEvent(db, {
          ...base,
          type: EVENT_TYPES.leaseHeartbeat,
          payload: { expiresAtMs: bootTimeMs + spec.heartbeatOffsetMs },
          createdAtMs: t++,
        });
      }
      const closing = {
        completed: EVENT_TYPES.stepCompleted,
        failed: EVENT_TYPES.stepFailed,
        reclaimed: EVENT_TYPES.leaseReclaimed,
      } as const;
      if (spec.kind === "completed" || spec.kind === "failed" || spec.kind === "reclaimed") {
        appendEvent(db, { ...base, type: closing[spec.kind], createdAtMs: t++ });
      }
    });
  });
}

function withDb(scenario: Scenario, fn: (db: Db) => void): void {
  const db = openEventLog(":memory:");
  try {
    seed(db, scenario);
    fn(db);
  } finally {
    db.close();
  }
}

describe("Feature: friday-design-orchestrator-harness, Property 19: Boot-time stale lease reclamation", () => {
  beforeEach(() => resetJobEngineRestoreForTests());
  afterEach(() => resetJobEngineRestoreForTests());

  it("appends exactly one lease-reclaimed event per stale running Step and none for any other Step", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { bootTimeMs } = scenario;
        withDb(scenario, (db) => {
          const before = loadEvents(db);
          const preReclaimed = before.filter((e) => e.type === EVENT_TYPES.leaseReclaimed).length;

          const expectedStale: string[] = [];
          scenario.jobs.forEach((steps, j) =>
            steps.forEach((spec, i) => {
              if (isStale(spec, bootTimeMs)) expectedStale.push(`${jobIdOf(j)}/${stepIdOf(j, i)}`);
            }),
          );

          const appended = reclaimStaleLeases(db, bootTimeMs);

          // Exactly one event per stale Step, each of the right type, and nothing else.
          expect(appended.every((e) => e.type === EVENT_TYPES.leaseReclaimed)).toBe(true);
          expect(appended.map((e) => `${e.jobId}/${e.stepId}`).sort()).toEqual(
            [...expectedStale].sort(),
          );

          // The log gained those events and no others.
          const after = loadEvents(db);
          expect(after).toHaveLength(before.length + expectedStale.length);
          expect(after.filter((e) => e.type === EVENT_TYPES.leaseReclaimed)).toHaveLength(
            preReclaimed + expectedStale.length,
          );

          // Idempotent: a second pass finds no running stale Step and appends nothing.
          expect(reclaimStaleLeases(db, bootTimeMs)).toEqual([]);
          expect(loadEvents(db)).toHaveLength(after.length);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("resumes exactly the interrupted Steps and never a Step that has a completion event", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { bootTimeMs } = scenario;
        resetJobEngineRestoreForTests();
        withDb(scenario, (db) => {
          const resumed: ResumeStepRequest[] = [];
          const completed = new Set<string>();
          const expectedResumed = new Map<string, boolean>(); // key -> reclaimed flag
          scenario.jobs.forEach((steps, j) =>
            steps.forEach((spec, i) => {
              const key = `${jobIdOf(j)}/${stepIdOf(j, i)}`;
              if (spec.kind === "completed") completed.add(key);
              if (spec.kind === "running" || spec.kind === "no-lease") {
                expectedResumed.set(key, isStale(spec, bootTimeMs));
              } else if (spec.kind === "reclaimed") {
                // Reclaimed by an earlier boot: still interrupted, but not reclaimed by this one.
                expectedResumed.set(key, false);
              }
            }),
          );

          const res = restoreJobEngineOnce(db, {
            bootTimeMs,
            resumeStep: (r) => {
              resumed.push(r);
            },
          });

          const keys = resumed.map((r) => `${r.jobId}/${r.stepId}`);
          // Property 20 clause: a completed Step is never re-executed.
          expect(keys.filter((k) => completed.has(k))).toEqual([]);
          // No Step is resumed twice, and the resumed set matches the model.
          expect(new Set(keys).size).toBe(keys.length);
          expect([...keys].sort()).toEqual([...expectedResumed.keys()].sort());
          for (const r of resumed) {
            expect(r.reclaimed).toBe(expectedResumed.get(`${r.jobId}/${r.stepId}`));
          }
          expect(res.resumed).toEqual(resumed);

          // Reclaim count in the restore result matches the stale Steps.
          const staleCount = [...expectedResumed.values()].filter(Boolean).length;
          expect(res.reclaimed).toHaveLength(staleCount);
          expect(res.reclaimed.every((e) => e.type === EVENT_TYPES.leaseReclaimed)).toBe(true);

          // A second restore in the same process is a no-op until the flag is reset.
          expect(restoreJobEngineOnce(db, { bootTimeMs, resumeStep: () => {} })).toEqual({
            reclaimed: [],
            resumed: [],
          });
        });
      }),
      { numRuns: 200 },
    );
  });

  it("does not reclaim a Step whose expiry equals the boot time", () => {
    const scenario: Scenario = {
      bootTimeMs: 50_000,
      jobs: [
        [
          { kind: "running", offsetMs: 0 },
          { kind: "running", offsetMs: -1 },
        ],
      ],
    };
    withDb(scenario, (db) => {
      const appended = reclaimStaleLeases(db, scenario.bootTimeMs);
      expect(appended.map((e) => e.stepId)).toEqual([stepIdOf(0, 1)]);
    });
  });
});
