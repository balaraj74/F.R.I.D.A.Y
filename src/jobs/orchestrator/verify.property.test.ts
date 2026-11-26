import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readyTasks } from "./schedule.js";
import { ROLES, type CheckResult, type TaskDef, type TaskState } from "./types.js";
import { MAX_VERIFICATION_ATTEMPTS, taskVerificationOutcome } from "./verify.js";

// Feature: friday-design-orchestrator-harness, Property 32: Task verification retry and failure
// **Validates: Requirements 7.9, 7.10, 7.11**

const NON_PASS: readonly CheckResult[] = ["fail", "no-evidence"];
const ANY_RESULT: readonly CheckResult[] = ["pass", ...NON_PASS];

const allPassArb = fc.array(fc.constant<CheckResult>("pass"), { minLength: 1, maxLength: 10 });
// At least one non-pass result, placed at an arbitrary position among other results.
const someNonPassArb = fc
  .tuple(
    fc.array(fc.constantFrom(...ANY_RESULT), { maxLength: 10 }),
    fc.constantFrom(...NON_PASS),
    fc.nat(),
  )
  .map(([rest, bad, pos]) => {
    const results = [...rest];
    results.splice(pos % (results.length + 1), 0, bad);
    return results;
  });

const attemptArb = fc.integer({ min: 1, max: 12 });
const retryableAttemptArb = fc.integer({ min: 1, max: MAX_VERIFICATION_ATTEMPTS - 1 });
const exhaustedAttemptArb = fc.integer({ min: MAX_VERIFICATION_ATTEMPTS, max: 12 });

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
const idArb = fc.constantFrom(...Array.from({ length: 10 }, (_, i) => `t${i}`));
const tasksArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: 10 }).chain((ids) =>
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

describe("Feature: friday-design-orchestrator-harness, Property 32: Task verification retry and failure", () => {
  it("returns done for any non-empty all-pass result set, regardless of attempt", () => {
    fc.assert(
      fc.property(allPassArb, attemptArb, (results, attempt) => {
        expect(taskVerificationOutcome(results, attempt)).toBe("done");
      }),
      { numRuns: 100 },
    );
  });

  it("returns retry for any fail/no-evidence result while fewer than 3 attempts have been made", () => {
    fc.assert(
      fc.property(someNonPassArb, retryableAttemptArb, (results, attempt) => {
        expect(taskVerificationOutcome(results, attempt)).toBe("retry");
      }),
      { numRuns: 100 },
    );
  });

  it("returns failed for any fail/no-evidence result once 3 attempts are exhausted", () => {
    fc.assert(
      fc.property(someNonPassArb, exhaustedAttemptArb, (results, attempt) => {
        expect(taskVerificationOutcome(results, attempt)).toBe("failed");
      }),
      { numRuns: 100 },
    );
  });

  it("a Task that never passes is retried twice and then failed on the third attempt", () => {
    fc.assert(
      fc.property(fc.array(someNonPassArb, { minLength: 3, maxLength: 3 }), (attempts) => {
        const outcomes = attempts.map((results, i) => taskVerificationOutcome(results, i + 1));
        expect(outcomes).toEqual(["retry", "retry", "failed"]);
      }),
      { numRuns: 100 },
    );
  });

  it("a failed Task never makes its dependents ready, whatever the other Task states are", () => {
    fc.assert(
      fc.property(
        tasksArb,
        fc.nat(),
        fc.dictionary(idArb, fc.constantFrom(...TASK_STATES)),
        someNonPassArb,
        (tasks, pick, others, results) => {
          const failedTask = tasks[pick % tasks.length]!;
          // Drive the failure through the verification decision, then record it in state.
          expect(taskVerificationOutcome(results, MAX_VERIFICATION_ATTEMPTS)).toBe("failed");
          const state: Record<string, TaskState> = { ...others, [failedTask.id]: "failed" };

          const ready = readyTasks(tasks, state);
          const dependents = tasks.filter((t) => t.dependsOn.includes(failedTask.id));
          for (const dependent of dependents) {
            expect(ready).not.toContain(dependent.id);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
