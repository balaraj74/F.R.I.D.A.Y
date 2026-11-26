import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { neverAutoReason } from "../../infra/autonomy-trust.js";
import { classifyAction } from "./approvals.js";
import { readyTasks } from "./schedule.js";
import { ROLES, type TaskDef, type TaskState } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 33: Never-auto classification gates approval and dependents only
// **Validates: Requirements 8.1, 8.2, 8.3**

// Kinds from the Never_Auto list in src/infra/autonomy-trust.ts.
const NEVER_AUTO_KINDS = [
  "git push",
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "bun publish",
  "docker push",
  "gh pr",
  "gh issue",
  "gh release",
  "gh repo",
  "gh gist",
  "twine",
  "net:send",
  "message:others",
  "mcp:browser",
  "mcp:send",
  "screen:look",
  "mcp:desktop",
  "code:merge",
  "mcp:github",
  "mcp:serena",
] as const;

// Kinds that are ordinary actions or near-misses of never-auto kinds.
const OTHER_KINDS = [
  "git commit",
  "git pull",
  "git pushx",
  "git push --force",
  "npm install",
  "npm publishes",
  "docker build",
  "gh auth",
  "curl download",
  "mcp:read",
  "mcp:github2",
  "screen:record",
  "ls",
  "",
] as const;

const kindArb = fc.oneof(
  fc.constantFrom<string>(...NEVER_AUTO_KINDS),
  fc.constantFrom<string>(...OTHER_KINDS),
  fc.string({ maxLength: 20 }),
  fc.stringMatching(/^[a-z]{2,8}( [a-z]{2,8})?$/),
  fc.stringMatching(/^[a-z]{2,6}:[a-z]{2,8}$/),
);

describe("Feature: friday-design-orchestrator-harness, Property 33: Never-auto classification gates approval and dependents only", () => {
  it("classifyAction(kind).neverAuto is true iff neverAutoReason(kind) is non-null", () => {
    fc.assert(
      fc.property(kindArb, (kind) => {
        const reason = neverAutoReason(kind);
        const result = classifyAction(kind);
        expect(result.neverAuto).toBe(reason !== null);
        expect(result.reason).toBe(reason);
      }),
      { numRuns: 200 },
    );
  });

  it("every real never-auto kind is classified never-auto with a reason", () => {
    fc.assert(
      fc.property(fc.constantFrom<string>(...NEVER_AUTO_KINDS), (kind) => {
        const result = classifyAction(kind);
        expect(result.neverAuto).toBe(true);
        expect(typeof result.reason).toBe("string");
        expect(result.reason).not.toBe("");
      }),
      { numRuns: 100 },
    );
  });

  it("ordinary kinds are not classified never-auto and carry no reason", () => {
    fc.assert(
      fc.property(fc.constantFrom<string>(...OTHER_KINDS), (kind) => {
        expect(neverAutoReason(kind)).toBeNull();
        expect(classifyAction(kind)).toEqual({ neverAuto: false, reason: null });
      }),
      { numRuns: 100 },
    );
  });

  // DAG over t0..tN-1 where a Task may only depend on lower-indexed Tasks (acyclic by construction).
  const graphArb = fc.integer({ min: 1, max: 12 }).chain((n) =>
    fc.tuple(
      fc.integer({ min: 0, max: n - 1 }),
      ...Array.from({ length: n }, (_, i) =>
        fc.record({
          role: fc.constantFrom(...ROLES),
          dependsOn: fc.uniqueArray(
            fc.integer({ min: 0, max: Math.max(0, i - 1) }).map((j) => `t${j}`),
            { maxLength: i === 0 ? 0 : 4 },
          ),
          // Used to pick the state of non-dependent Tasks.
          done: fc.boolean(),
          // Used to pick a non-done state for dependents of the waiting Task.
          blockedState: fc.constantFrom<TaskState>("pending", "failed", "skipped", "cancelled"),
        }),
      ),
    ),
  );

  it("a waiting_approval Task and all its transitive dependents are never ready; independent pending Tasks still are", () => {
    fc.assert(
      fc.property(graphArb, ([waitingIndex, ...nodes]) => {
        const tasks: TaskDef[] = nodes.map((node, i) => ({
          id: `t${i}`,
          role: node.role,
          // A Task at index 0 has no earlier Task to depend on.
          dependsOn: i === 0 ? [] : node.dependsOn,
          acceptanceChecks: [],
        }));
        const waitingId = `t${waitingIndex}`;

        // Transitive dependents of the waiting Task.
        const dependents = new Set<string>();
        for (const task of tasks) {
          if (task.dependsOn.some((d) => d === waitingId || dependents.has(d))) {
            dependents.add(task.id);
          }
        }

        // Tasks are in index order, so every dependency is visited before its dependent.
        const state: Record<string, TaskState> = {};
        for (const [i, task] of tasks.entries()) {
          if (task.id === waitingId) state[task.id] = "waiting_approval";
          else if (dependents.has(task.id)) state[task.id] = nodes[i].blockedState;
          else state[task.id] = nodes[i].done ? "done" : "pending";
        }

        const ready = readyTasks(tasks, state);

        // The waiting Task and its dependents are never scheduled.
        expect(ready).not.toContain(waitingId);
        for (const id of dependents) expect(ready).not.toContain(id);

        // Independent Tasks keep their normal readiness: pending with every dependency done.
        const expected = tasks
          .filter((t) => !dependents.has(t.id) && t.id !== waitingId)
          .filter((t) => state[t.id] === "pending")
          .filter((t) => t.dependsOn.every((d) => state[d] === "done"))
          .map((t) => t.id);
        expect(ready).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("an independent pending Task with no dependencies stays ready while another Task awaits approval", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 8 }), (chain, free) => {
        // Chain c0 <- c1 <- ... where c0 awaits approval, plus `free` independent root Tasks.
        const tasks: TaskDef[] = [];
        for (let i = 0; i < chain; i++) {
          tasks.push({
            id: `c${i}`,
            role: "builder",
            dependsOn: i === 0 ? [] : [`c${i - 1}`],
            acceptanceChecks: [],
          });
        }
        for (let i = 0; i < free; i++) {
          tasks.push({ id: `f${i}`, role: "researcher", dependsOn: [], acceptanceChecks: [] });
        }
        const state: Record<string, TaskState> = { c0: "waiting_approval" };
        const ready = readyTasks(tasks, state);
        expect(ready).toEqual(Array.from({ length: free }, (_, i) => `f${i}`));
      }),
      { numRuns: 100 },
    );
  });
});
