import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { denyOutcome, type TaskDef } from "./index.js";

// Feature: friday-design-orchestrator-harness, Property 35: Deny outcome depends on downstream need
// **Validates: Requirements 8.8**

type Graph = { tasks: TaskDef[]; deniedId: string };

/**
 * Random DAG: task `i` may only depend on tasks with a lower index, so the graph is acyclic by
 * construction. `requiresOutputFrom` may name any task (ancestor, dependent or unrelated) so the
 * property also covers requirements declared by Tasks that are not dependents of the denied Task.
 */
const graphArb: fc.Arbitrary<Graph> = fc.integer({ min: 1, max: 10 }).chain((n) => {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const taskArbs = ids.map((id, i) =>
    fc
      .record({
        dependsOn: fc.subarray(ids.slice(0, i)),
        requiresOutputFrom: fc.option(fc.subarray(ids), { nil: undefined }),
      })
      .map(
        ({ dependsOn, requiresOutputFrom }): TaskDef => ({
          id,
          role: "builder",
          dependsOn,
          acceptanceChecks: [],
          ...(requiresOutputFrom ? { requiresOutputFrom } : {}),
        }),
      ),
  );
  return fc
    .tuple(fc.tuple(...taskArbs), fc.constantFrom(...ids))
    .map(([tasks, deniedId]) => ({ tasks, deniedId }));
});

/** Direct and transitive dependents via fixed-point iteration (independent of the implementation's BFS). */
function downstreamOf({ tasks, deniedId }: Graph): Set<string> {
  const downstream = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (downstream.has(t.id)) continue;
      if (t.dependsOn.some((d) => d === deniedId || downstream.has(d))) {
        downstream.add(t.id);
        grew = true;
      }
    }
  }
  return downstream;
}

function expectedOutcome(graph: Graph): "skipped" | "failed" {
  const { tasks, deniedId } = graph;
  const downstream = downstreamOf(graph);
  const needed = tasks.some(
    (t) => downstream.has(t.id) && (t.requiresOutputFrom ?? []).includes(deniedId),
  );
  return needed ? "failed" : "skipped";
}

describe("Feature: friday-design-orchestrator-harness, Property 35: Deny outcome depends on downstream need", () => {
  it("returns skipped iff no direct or transitive dependent requires the denied Task's output, else failed", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(graphArb, (graph) => {
        const outcome = denyOutcome(graph.deniedId, graph.tasks, {});
        seen.add(outcome);
        expect(outcome).toBe(expectedOutcome(graph));
      }),
      { numRuns: 200 },
    );
    // Guard against a generator that only ever exercises one branch.
    expect(seen).toEqual(new Set(["skipped", "failed"]));
  });

  it("is unaffected by Tasks that require the output but are not dependents of the denied Task", () => {
    fc.assert(
      fc.property(graphArb, (graph) => {
        // Strip every requirement from non-dependents; the outcome must not change.
        const downstream = downstreamOf(graph);
        const stripped = graph.tasks.map((t) =>
          downstream.has(t.id) ? t : { ...t, requiresOutputFrom: undefined },
        );
        expect(denyOutcome(graph.deniedId, stripped, {})).toBe(
          denyOutcome(graph.deniedId, graph.tasks, {}),
        );
      }),
      { numRuns: 100 },
    );
  });
});
