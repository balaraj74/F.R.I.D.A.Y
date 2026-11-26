import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendEvent,
  loadEvents,
  loadEventsWithWarnings,
  openEventLog,
  type AppendedEvent,
  type NewEvent,
} from "./index.js";

// Feature: friday-design-orchestrator-harness, Property 21: Truncated trailing event is discarded, not the log

const jobId = fc.constantFrom("j1", "j2");
const optionalId = (ids: string[]) => fc.option(fc.constantFrom(...ids), { nil: undefined });
const eventType = fc.constantFrom("job-created", "task-created", "step-started", "something-new");

const newEvent: fc.Arbitrary<NewEvent> = fc
  .record({
    jobId,
    taskId: optionalId(["t1", "t2"]),
    stepId: optionalId(["s1", "s2"]),
    type: eventType,
    payload: fc.option(fc.jsonValue({ maxDepth: 3 }), { nil: undefined }),
    createdAtMs: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((e) => {
    // Drop explicit `undefined` keys so NewEvent matches what callers really pass.
    const out: NewEvent = { jobId: e.jobId, type: e.type, createdAtMs: e.createdAtMs };
    if (e.taskId !== undefined) out.taskId = e.taskId;
    if (e.stepId !== undefined) out.stepId = e.stepId;
    if (e.payload !== undefined) out.payload = e.payload;
    return out;
  });

const precedingEvents = fc.array(newEvent, { maxLength: 30 });

function isInvalidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return false;
  } catch {
    return true;
  }
}

// A crash mid-write leaves a strict prefix of a serialized object (always invalid JSON).
const truncatedObjectJson = fc
  .dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue({ maxDepth: 2 }), {
    minKeys: 1,
  })
  .chain((obj) => {
    const json = JSON.stringify(obj);
    return fc.integer({ min: 0, max: json.length - 1 }).map((cut) => json.slice(0, cut));
  });

const corruptPayload = fc.oneof(
  truncatedObjectJson,
  fc.string({ maxLength: 20 }).filter(isInvalidJson),
  fc.constantFrom("", "{", '{"half":', "[1,2,", "nul", "}{"),
);

/**
 * Appends `valid` events plus one more, then overwrites the final row's payload with
 * unparseable text directly via SQL (what a crash mid-write would leave behind).
 */
function buildCorruptedLog(valid: NewEvent[], corrupted: NewEvent, badPayload: string) {
  const db = openEventLog(":memory:");
  const appended = valid.map((e) => appendEvent(db, e));
  const last = appendEvent(db, corrupted);
  db.prepare("UPDATE events SET payload = ? WHERE id = ?").run(badPayload, last.id);
  return { db, appended, corruptedId: last.id };
}

describe("Property 21: Truncated trailing event is discarded, not the log", () => {
  it("keeps every preceding event in order, drops the corrupted final row, and warns", () => {
    // **Validates: Requirements 5.12**
    fc.assert(
      fc.property(precedingEvents, newEvent, corruptPayload, (valid, corrupted, badPayload) => {
        const { db, appended, corruptedId } = buildCorruptedLog(valid, corrupted, badPayload);
        try {
          const { events, warnings } = loadEventsWithWarnings(db);
          expect(events).toEqual(appended);
          expect(events.map((e: AppendedEvent) => e.id)).toEqual(appended.map((e) => e.id));
          expect(events.some((e) => e.id === corruptedId)).toBe(false);

          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatchObject({ eventId: corruptedId, position: "final" });
          expect(warnings[0]!.reason.length).toBeGreaterThan(0);

          // The logging wrapper never throws and returns the same surviving events.
          expect(loadEvents(db)).toEqual(appended);
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("filtering by the corrupted event's job still drops only the final row", () => {
    // **Validates: Requirements 5.12**
    fc.assert(
      fc.property(precedingEvents, newEvent, corruptPayload, (valid, corrupted, badPayload) => {
        const { db, appended, corruptedId } = buildCorruptedLog(valid, corrupted, badPayload);
        try {
          const forJob = appended.filter((e) => e.jobId === corrupted.jobId);
          const { events, warnings } = loadEventsWithWarnings(db, corrupted.jobId);
          expect(events).toEqual(forJob);
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatchObject({ eventId: corruptedId, position: "final" });

          // Other jobs are unaffected and report no warnings.
          const other = corrupted.jobId === "j1" ? "j2" : "j1";
          const otherResult = loadEventsWithWarnings(db, other);
          expect(otherResult.events).toEqual(appended.filter((e) => e.jobId === other));
          expect(otherResult.warnings).toEqual([]);
        } finally {
          db.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns an empty log with one warning when the only row is truncated", () => {
    // **Validates: Requirements 5.12**
    const { db, corruptedId } = buildCorruptedLog([], { jobId: "j1", type: "x" }, '{"half":');
    try {
      const { events, warnings } = loadEventsWithWarnings(db);
      expect(events).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ eventId: corruptedId, position: "final" });
    } finally {
      db.close();
    }
  });
});
