import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JOB_STATES, TASK_STATES } from "./types";
import type { JobView, TaskView } from "./types";
import { boardColumnFor, costRollup } from "./views";

// Feature: friday-design-orchestrator-harness, Property 48: Board column mapping and cost rollup
// **Validates: Requirements 12.1, 12.5**

const COLUMNS = ["running", "waiting", "done"];

const taskArb = (id: string): fc.Arbitrary<TaskView> =>
  fc
    .record({
      inputTokens: fc.nat({ max: 1_000_000 }),
      outputTokens: fc.nat({ max: 1_000_000 }),
      elapsedMs: fc.nat({ max: 1_000_000 }),
      state: fc.constantFrom(...TASK_STATES),
    })
    .map(({ inputTokens, outputTokens, elapsedMs, state }) => ({
      id,
      jobId: "j1",
      dependsOn: [],
      state,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, elapsedMs },
    }));

const jobArb: fc.Arbitrary<JobView> = fc
  .uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/), { maxLength: 12 })
  .chain((ids) =>
    fc
      .tuple(fc.constantFrom(...JOB_STATES), fc.tuple(...ids.map(taskArb)))
      .map(([state, tasks]) => ({
        id: "j1",
        state,
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      })),
  );

describe("Property 48: board column mapping and cost rollup", () => {
  it("maps every JobState to exactly one of running, waiting, done", () => {
    fc.assert(
      fc.property(fc.constantFrom(...JOB_STATES), (state) => {
        const column = boardColumnFor(state);
        expect(COLUMNS.filter((c) => c === column)).toHaveLength(1);
        // Deterministic: the same state always lands in the same column.
        expect(boardColumnFor(state)).toBe(column);
      }),
      { numRuns: 100 },
    );
  });

  it("jobTotal equals the sum of the perTask values", () => {
    fc.assert(
      fc.property(jobArb, (job) => {
        const rollup = costRollup(job);
        const sum = Object.values(rollup.perTask).reduce((a, b) => a + b, 0);
        expect(rollup.jobTotal).toBe(sum);
        expect(Object.keys(rollup.perTask).sort()).toEqual(Object.keys(job.tasks).sort());
        for (const [id, task] of Object.entries(job.tasks)) {
          expect(rollup.perTask[id]).toBe(task.usage.totalTokens);
        }
      }),
      { numRuns: 100 },
    );
  });
});
