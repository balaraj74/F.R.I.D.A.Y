import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { appendEvent, loadEvents, openEventLog, projectJobState } from "./index.js";
import { EVENT_TYPES } from "./project.js";
import { JOB_STATES, TASK_STATES, type NewEvent } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 20: Event log replay is idempotent and deterministic

const jobId = fc.constantFrom("j1", "j2");
const taskId = fc.option(fc.constantFrom("t1", "t2", "t3"), { nil: undefined });
const stepId = fc.option(fc.constantFrom("s1", "s2", "s3"), { nil: undefined });
const smallText = fc.string({ maxLength: 12 });
const ms = fc.integer({ min: 0, max: 1_000_000 });

// Payloads mix well-formed shapes for known event types with arbitrary JSON, so the fold
// sees both valid transitions and junk it must ignore.
const knownPayload = fc.oneof(
  fc.record(
    {
      type: fc.constantFrom("coding", "research", "operations", "bogus"),
      goal: smallText,
      branch: smallText,
    },
    { requiredKeys: [] },
  ),
  fc.record(
    { to: fc.oneof(fc.constantFrom(...JOB_STATES, ...TASK_STATES), smallText), reason: smallText },
    { requiredKeys: [] },
  ),
  fc.record(
    {
      role: smallText,
      dependsOn: fc.array(fc.oneof(smallText, fc.integer())),
      acceptanceChecks: fc.array(fc.jsonValue({ maxDepth: 2 })),
    },
    { requiredKeys: [] },
  ),
  fc.record(
    { model: smallText, leaseExpiresAtMs: ms, expiresAtMs: ms, reason: smallText },
    { requiredKeys: [] },
  ),
  fc.constant(undefined),
);

const eventType = fc.oneof(
  fc.constantFrom(...Object.values(EVENT_TYPES)),
  fc.constant("something-new"),
);

const newEvent: fc.Arbitrary<NewEvent> = fc
  .record(
    {
      jobId,
      taskId,
      stepId,
      type: eventType,
      payload: knownPayload,
      createdAtMs: ms,
    },
    { requiredKeys: ["jobId", "type", "createdAtMs"] },
  )
  .map((e) => {
    // Drop explicit `undefined` keys so NewEvent matches what callers really pass.
    const out: NewEvent = { jobId: e.jobId, type: e.type, createdAtMs: e.createdAtMs };
    if (e.taskId !== undefined) out.taskId = e.taskId;
    if (e.stepId !== undefined) out.stepId = e.stepId;
    if (e.payload !== undefined) out.payload = e.payload;
    return out;
  });

const eventSequence = fc.array(newEvent, { maxLength: 40 });

function appendAll(events: NewEvent[]) {
  const db = openEventLog(":memory:");
  for (const e of events) appendEvent(db, e);
  return db;
}

describe("Property 20: Event log replay is idempotent and deterministic", () => {
  it("projecting the same events twice gives deep-equal results", () => {
    // **Validates: Requirements 5.10, 5.11**
    fc.assert(
      fc.property(eventSequence, (events) => {
        const db = appendAll(events);
        try {
          const loaded = loadEvents(db);
          expect(projectJobState(loaded)).toEqual(projectJobState(loaded));
          // A freshly loaded copy of the same log projects identically too.
          expect(projectJobState(loadEvents(db))).toEqual(projectJobState(loaded));
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("loading from the DB twice and projecting gives equal results", () => {
    // **Validates: Requirements 5.10, 5.11**
    fc.assert(
      fc.property(eventSequence, (events) => {
        const db = appendAll(events);
        try {
          const first = loadEvents(db);
          const second = loadEvents(db);
          expect(second).toEqual(first);
          expect(first).toHaveLength(events.length);
          expect(projectJobState(second)).toEqual(projectJobState(first));
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("projection does not mutate its input", () => {
    // **Validates: Requirements 5.10, 5.11**
    fc.assert(
      fc.property(eventSequence, (events) => {
        const db = appendAll(events);
        try {
          const loaded = loadEvents(db);
          const snapshot = structuredClone(loaded);
          const projection = projectJobState(loaded);
          expect(loaded).toEqual(snapshot);
          // Mutating the result must not leak into the input or later projections.
          const again = structuredClone(projection);
          for (const job of Object.values(projection.jobs)) {
            job.timeline.length = 0;
            job.tasks = {};
            job.steps = {};
          }
          expect(loaded).toEqual(snapshot);
          expect(projectJobState(loaded)).toEqual(again);
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
