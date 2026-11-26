import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENCY, MIN_CONCURRENCY, readyTasks, schedule } from "./schedule.js";
import { ROLES, type TaskDef, type TaskState } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 30: Scheduling respects the concurrency limit
// **Validates: Requirements 7.6**

const TASK_STATES: readonly TaskState[] = [
  "pending",
  "running",
  "waiting_approval",
  "verifying",
  "done",
  "failed",
  "cancelled",
  "skipped",
];

const limitArb = fc.integer({ min: MIN_CONCURRENCY, max: MAX_CONCURRENCY });
const runningArb = fc.integer({ min: 0, max: 40 });
const idArb = fc.constantFrom(...Array.from({ length: 12 }, (_, i) => `t${i}`));

// Unique task ids; dependencies may name any id, including ones outside the task set.
const tasksArb = fc.uniqueArray(idArb, { minLength: 0, maxLength: 12 }).chain((ids) =>
  fc.tuple(
    ...ids.map((id) =>
      fc
        .record({
          role: fc.constantFrom(...ROLES),
          dependsOn: fc.uniqueArray(idArb, { maxLength: 4 }),
        })
        .map((rest): TaskDef => ({ id, ...rest, acceptanceChecks: [] })),
    ),
  ),
);

// Missing entries stand for "pending", so the state map is deliberately partial.
const stateArb = fc.dictionary(idArb, fc.constantFrom(...TASK_STATES));

const readyIdsArb = fc.array(idArb, { maxLength: 30 });

describe("Feature: friday-design-orchestrator-harness, Property 30: Scheduling respects the concurrency limit", () => {
  it("readyTasks returns exactly the pending tasks whose dependencies are all done, in task order", () => {
    fc.assert(
      fc.property(tasksArb, stateArb, (tasks, state) => {
        const expected = tasks
          .filter((t) => (state[t.id] ?? "pending") === "pending")
          .filter((t) => t.dependsOn.every((d) => state[d] === "done"))
          .map((t) => t.id);
        const ready = readyTasks(tasks, state);
        expect(ready).toEqual(expected);
        for (const id of ready) {
          const task = tasks.find((t) => t.id === id)!;
          expect(state[id] ?? "pending").toBe("pending");
          expect(task.dependsOn.every((d) => state[d] === "done")).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("schedule returns at most limit - runningCount ids, drawn in order from the ready list without duplicates", () => {
    fc.assert(
      fc.property(readyIdsArb, runningArb, limitArb, (ready, running, limit) => {
        const picked = schedule(ready, running, limit);
        const slots = Math.max(0, limit - running);

        expect(picked.length).toBeLessThanOrEqual(slots);
        expect(new Set(picked).size).toBe(picked.length);
        for (const id of picked) expect(ready).toContain(id);

        // Order is preserved: the result is a prefix of the ready list's unique ids.
        const unique = [...new Set(ready)];
        expect(picked).toEqual(unique.slice(0, picked.length));
        // Nothing is held back while a slot is free.
        expect(picked.length).toBe(Math.min(slots, unique.length));
      }),
      { numRuns: 100 },
    );
  });

  it("running plus scheduled never exceeds the limit while running is within the limit", () => {
    fc.assert(
      fc.property(
        readyIdsArb,
        limitArb.chain((limit) => fc.tuple(fc.constant(limit), fc.integer({ min: 0, max: limit }))),
        (ready, [limit, running]) => {
          expect(running + schedule(ready, running, limit).length).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("schedules nothing when the limit is already reached or exceeded", () => {
    fc.assert(
      fc.property(readyIdsArb, limitArb, fc.integer({ min: 0, max: 40 }), (ready, limit, extra) => {
        expect(schedule(ready, limit + extra, limit)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("includes the next unscheduled ready task as soon as a running slot frees up", () => {
    fc.assert(
      fc.property(
        readyIdsArb,
        limitArb.chain((limit) => fc.tuple(fc.constant(limit), fc.integer({ min: 1, max: limit }))),
        (ready, [limit, running]) => {
          const before = schedule(ready, running, limit);
          const after = schedule(ready, running - 1, limit);
          const unique = [...new Set(ready)];
          if (before.length < unique.length) {
            // A task that was held back is now started, and earlier picks are unchanged.
            expect(after).toEqual(unique.slice(0, before.length + 1));
          } else {
            expect(after).toEqual(before);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("throws RangeError for any limit that is not an integer from 1 to 16", () => {
    const invalidLimitArb = fc.oneof(
      fc.integer({ min: -1_000_000, max: MIN_CONCURRENCY - 1 }),
      fc.integer({ min: MAX_CONCURRENCY + 1, max: 1_000_000 }),
      fc.double({ noInteger: true }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    );
    fc.assert(
      fc.property(readyIdsArb, runningArb, invalidLimitArb, (ready, running, limit) => {
        expect(() => schedule(ready, running, limit)).toThrow(RangeError);
      }),
      { numRuns: 100 },
    );
  });
});
