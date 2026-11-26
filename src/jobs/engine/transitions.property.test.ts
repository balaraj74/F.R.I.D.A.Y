import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendEvent,
  EVENT_TYPES,
  JOB_STATES,
  loadEvents,
  openEventLog,
  projectJobState,
  type JobState,
} from "../store/index.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  requestTransition,
  TERMINAL_JOB_STATES,
} from "./state-machine.js";

// Feature: friday-design-orchestrator-harness, Property 17: Allowed Job state transitions
// **Validates: Requirements 5.4, 5.5, 5.6**

const jobState = fc.constantFrom<JobState>(...JOB_STATES);
const nonTerminal = JOB_STATES.filter((s) => !TERMINAL_JOB_STATES.includes(s));

/** Design's Error Handling table (ALLOWED_TRANSITIONS plus the paused rows), written out independently. */
const EXPECTED: Record<JobState, JobState[]> = {
  pending: ["running", "cancelled"],
  running: ["waiting_approval", "verifying", "failed", "cancelled", "paused"],
  waiting_approval: ["running", "cancelled"],
  verifying: ["done", "running", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

/** Fresh in-memory log with one Job whose projected state is `state`. */
function seedJob(state: JobState, jobId = "j1") {
  const db = openEventLog(":memory:");
  appendEvent(db, { jobId, type: EVENT_TYPES.jobCreated, payload: { goal: "g" }, createdAtMs: 1 });
  if (state !== "pending") {
    appendEvent(db, {
      jobId,
      type: EVENT_TYPES.jobStateChanged,
      payload: { to: state },
      createdAtMs: 2,
    });
  }
  return { db, jobId };
}

function currentState(db: ReturnType<typeof openEventLog>, jobId: string): JobState | undefined {
  return projectJobState(loadEvents(db, jobId)).jobs[jobId]?.state;
}

describe("Property 17: Allowed Job state transitions", () => {
  it("canTransition matches ALLOWED_TRANSITIONS for every (from, to) pair", () => {
    fc.assert(
      fc.property(jobState, jobState, (from, to) => {
        expect(canTransition(from, to)).toBe(ALLOWED_TRANSITIONS[from].includes(to));
        expect(canTransition(from, to)).toBe(EXPECTED[from].includes(to));
      }),
      { numRuns: 100 },
    );
  });

  it("any non-terminal state may transition to cancelled", () => {
    fc.assert(
      fc.property(fc.constantFrom<JobState>(...nonTerminal), (from) => {
        expect(canTransition(from, "cancelled")).toBe(true);
        const { db, jobId } = seedJob(from);
        expect(requestTransition(db, jobId, "cancelled").ok).toBe(true);
        expect(currentState(db, jobId)).toBe("cancelled");
      }),
      { numRuns: 50 },
    );
  });

  it("terminal states reject every target", () => {
    fc.assert(
      fc.property(fc.constantFrom<JobState>(...TERMINAL_JOB_STATES), jobState, (from, to) => {
        expect(canTransition(from, to)).toBe(false);
        const { db, jobId } = seedJob(from);
        const before = loadEvents(db, jobId).length;
        const res = requestTransition(db, jobId, to);
        expect(res.ok).toBe(false);
        expect(loadEvents(db, jobId)).toHaveLength(before);
        expect(currentState(db, jobId)).toBe(from);
      }),
      { numRuns: 100 },
    );
  });

  it("requestTransition succeeds with exactly one event iff allowed; rejection changes nothing", () => {
    fc.assert(
      fc.property(jobState, jobState, (from, to) => {
        const { db, jobId } = seedJob(from);
        const eventsBefore = loadEvents(db, jobId);
        const projectionBefore = projectJobState(eventsBefore);
        expect(currentState(db, jobId)).toBe(from);

        const res = requestTransition(db, jobId, to);
        const eventsAfter = loadEvents(db, jobId);

        if (canTransition(from, to)) {
          expect(res.ok).toBe(true);
          expect(eventsAfter).toHaveLength(eventsBefore.length + 1);
          const added = eventsAfter[eventsAfter.length - 1]!;
          expect(added.type).toBe(EVENT_TYPES.jobStateChanged);
          expect(added.jobId).toBe(jobId);
          expect(added.payload).toMatchObject({ from, to });
          expect(currentState(db, jobId)).toBe(to);
        } else {
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.error.kind).toBe("not-allowed");
          expect(eventsAfter).toEqual(eventsBefore);
          expect(projectJobState(eventsAfter)).toEqual(projectionBefore);
        }
      }),
      { numRuns: 100 },
    );
  });
});
