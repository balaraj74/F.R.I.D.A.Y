import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_VERIFY_ATTEMPTS,
  planMergeOrder,
  verifyOutcome,
  type MergeableTask,
  type VerifyDecision,
} from "./logic.js";

// Feature: friday-design-orchestrator-harness, Property 37: Coding task merge decision
// **Validates: Requirements 9.3, 9.4, 9.5, 9.6**

type Attempt = { tests: boolean; lint: boolean };

const attemptArb: fc.Arbitrary<Attempt> = fc.record({ tests: fc.boolean(), lint: fc.boolean() });
/** Between 1 and 3 verification attempts, each with a tests and a lint result. */
const attemptsArb = fc.array(attemptArb, { minLength: 1, maxLength: MAX_VERIFY_ATTEMPTS });

/**
 * A dependency graph that is acyclic by construction: task `i` may only depend on
 * tasks with a lower index, plus optional ids that are not in the done set.
 * The input order is then shuffled so dependents can appear before their dependencies.
 */
const dagArb: fc.Arbitrary<MergeableTask[]> = fc
  .integer({ min: 0, max: 12 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.record({
          internal: i === 0 ? fc.constant<number[]>([]) : fc.uniqueArray(fc.nat({ max: i - 1 })),
          external: fc.uniqueArray(fc.constantFrom("ext-a", "ext-b", "ext-c")),
        }),
      ),
    ),
  )
  .chain((deps) => {
    const tasks: MergeableTask[] = deps.map((d, i) => ({
      id: `task-${i}`,
      dependsOn: [...d.internal.map((j) => `task-${j}`), ...d.external],
    }));
    return fc.shuffledSubarray(tasks, { minLength: tasks.length, maxLength: tasks.length });
  });

describe("Feature: friday-design-orchestrator-harness, Property 37: Coding task merge decision", () => {
  it("merges iff both tests and lint pass, regardless of attempt number", () => {
    fc.assert(
      fc.property(attemptArb, fc.integer({ min: 1, max: 6 }), (a, attempt) => {
        const decision = verifyOutcome(a.tests, a.lint, attempt);
        expect(decision === "merge").toBe(a.tests && a.lint);
      }),
      { numRuns: 200 },
    );
  });

  it("retries while attempt < 3 and fails once 3 attempts are used, when a check failed", () => {
    fc.assert(
      fc.property(
        attemptArb.filter((a) => !(a.tests && a.lint)),
        fc.integer({ min: 1, max: 6 }),
        (a, attempt) => {
          const expected: VerifyDecision = attempt < MAX_VERIFY_ATTEMPTS ? "retry" : "failed";
          expect(verifyOutcome(a.tests, a.lint, attempt)).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("over a sequence of up to 3 attempts, decides on the latest attempt and ends in merge or failed at attempt 3", () => {
    fc.assert(
      fc.property(attemptsArb, (attempts) => {
        const decisions = attempts.map((a, i) => verifyOutcome(a.tests, a.lint, i + 1));
        const last = attempts.length - 1;
        const latestPassed = attempts[last].tests && attempts[last].lint;
        const final = decisions[last];
        if (latestPassed) {
          expect(final).toBe("merge");
        } else if (attempts.length < MAX_VERIFY_ATTEMPTS) {
          expect(final).toBe("retry");
        } else {
          expect(final).toBe("failed");
        }
        // Only the final attempt can be terminal (merge/failed) when earlier ones failed.
        for (let i = 0; i < last; i += 1) {
          const passed = attempts[i].tests && attempts[i].lint;
          expect(decisions[i]).toBe(passed ? "merge" : "retry");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("merge order lists every done task exactly once, dependencies before dependents", () => {
    fc.assert(
      fc.property(dagArb, (tasks) => {
        const order = planMergeOrder(tasks);
        expect(order).toHaveLength(tasks.length);
        expect(new Set(order).size).toBe(tasks.length);
        expect([...order].sort()).toEqual(tasks.map((t) => t.id).sort());

        const position = new Map(order.map((id, i) => [id, i]));
        for (const task of tasks) {
          for (const dep of task.dependsOn) {
            const depPos = position.get(dep);
            // Dependencies outside the done set are ignored.
            if (depPos !== undefined) {
              expect(depPos).toBeLessThan(position.get(task.id) as number);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("merge order is deterministic for the same input", () => {
    fc.assert(
      fc.property(dagArb, (tasks) => {
        expect(planMergeOrder(tasks)).toEqual(planMergeOrder(tasks));
      }),
      { numRuns: 100 },
    );
  });
});
