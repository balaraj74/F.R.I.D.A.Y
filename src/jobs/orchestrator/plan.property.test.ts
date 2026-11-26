import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_CHECKS, MAX_TASKS, ROLES, validatePlan, type Role, type TaskDef } from "./index.js";

// Feature: friday-design-orchestrator-harness, Property 28: Plan structural validity
// **Validates: Requirements 7.1, 7.4**

const checksOf = (count: number): TaskDef["acceptanceChecks"] =>
  Array.from({ length: count }, () => ({ type: "file_exists" as const, path: "a.txt" }));

const roleArb = fc.constantFrom<Role>(...ROLES);
const checkCountArb = fc.integer({ min: 1, max: MAX_CHECKS });

/**
 * Valid DAG of `minSize..maxSize` tasks. Each task depends only on tasks with a lower
 * index (so no cycle is possible), then the array is shuffled so dependency order and
 * array order differ.
 */
const dagArb = (minSize: number, maxSize: number): fc.Arbitrary<TaskDef[]> =>
  fc
    .array(
      fc.record({
        role: roleArb,
        checks: checkCountArb,
        picks: fc.array(fc.nat(), { maxLength: 4 }),
        sortKey: fc.nat(),
      }),
      { minLength: minSize, maxLength: maxSize },
    )
    .map((specs) => {
      const tasks = specs.map((spec, i): { task: TaskDef; sortKey: number } => ({
        sortKey: spec.sortKey,
        task: {
          id: `t${i}`,
          role: spec.role,
          dependsOn: i === 0 ? [] : [...new Set(spec.picks.map((p) => `t${p % i}`))],
          acceptanceChecks: checksOf(spec.checks),
        },
      }));
      return tasks.toSorted((a, b) => a.sortKey - b.sortKey).map((entry) => entry.task);
    });

const errorsOf = (tasks: readonly TaskDef[]): string[] => {
  const result = validatePlan(tasks);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
};

/** Replace the task at `index` with `patch` applied; returns a new array. */
const patchAt = (tasks: TaskDef[], index: number, patch: Partial<TaskDef>): TaskDef[] =>
  tasks.map((t, i) => (i === index ? { ...t, ...patch } : t));

describe("Feature: friday-design-orchestrator-harness, Property 28: Plan structural validity", () => {
  it("accepts every valid DAG of 1-50 tasks", () => {
    fc.assert(
      fc.property(dagArb(1, MAX_TASKS), (tasks) => {
        expect(validatePlan(tasks)).toEqual({ ok: true });
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a plan with more than 50 tasks", () => {
    fc.assert(
      fc.property(dagArb(MAX_TASKS + 1, MAX_TASKS + 10), (tasks) => {
        expect(errorsOf(tasks).length).toBeGreaterThan(0);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects an empty plan", () => {
    expect(errorsOf([]).length).toBeGreaterThan(0);
  });

  it("rejects a duplicate id and names it", () => {
    fc.assert(
      fc.property(dagArb(1, MAX_TASKS - 1), fc.nat(), (tasks, pick) => {
        const original = tasks[pick % tasks.length] as TaskDef;
        const errors = errorsOf([...tasks, { ...original }]);
        expect(errors.some((e) => e.startsWith(`task ${original.id}:`))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a dependency on a missing task and names the offending task", () => {
    fc.assert(
      fc.property(dagArb(1, MAX_TASKS), fc.nat(), (tasks, pick) => {
        const index = pick % tasks.length;
        const owner = tasks[index] as TaskDef;
        const mutated = patchAt(tasks, index, { dependsOn: [...owner.dependsOn, "missing-task"] });
        const errors = errorsOf(mutated);
        expect(
          errors.some((e) => e.startsWith(`task ${owner.id}:`) && e.includes("missing-task")),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a self-dependency and names the offending task", () => {
    fc.assert(
      fc.property(dagArb(1, MAX_TASKS), fc.nat(), (tasks, pick) => {
        const index = pick % tasks.length;
        const owner = tasks[index] as TaskDef;
        const mutated = patchAt(tasks, index, { dependsOn: [...owner.dependsOn, owner.id] });
        const errors = errorsOf(mutated);
        expect(errors.some((e) => e.startsWith(`task ${owner.id}:`))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a dependency cycle and names every task on the cycle", () => {
    fc.assert(
      fc.property(
        dagArb(2, MAX_TASKS),
        fc.array(fc.nat(), { minLength: 2, maxLength: 6 }),
        (tasks, picks) => {
          // Distinct ring members; wiring each to the next closes a cycle whatever the DAG edges are.
          const ring = [...new Set(picks.map((p) => p % tasks.length))];
          fc.pre(ring.length >= 2);
          const ids = ring.map((i) => (tasks[i] as TaskDef).id);
          const mutated = tasks.map((t) => {
            const at = ids.indexOf(t.id);
            if (at === -1) return t;
            const next = ids[(at + 1) % ids.length] as string;
            return { ...t, dependsOn: [...new Set([...t.dependsOn, next])] };
          });
          const errors = errorsOf(mutated);
          for (const id of ids) {
            expect(errors.some((e) => e.startsWith(`task ${id}:`))).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects 0 or 11 acceptance checks and names the offending task", () => {
    fc.assert(
      fc.property(
        dagArb(1, MAX_TASKS),
        fc.nat(),
        fc.constantFrom(0, MAX_CHECKS + 1),
        (tasks, pick, count) => {
          const index = pick % tasks.length;
          const owner = tasks[index] as TaskDef;
          const errors = errorsOf(patchAt(tasks, index, { acceptanceChecks: checksOf(count) }));
          expect(errors.some((e) => e.startsWith(`task ${owner.id}:`))).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects an invalid role and names the offending task", () => {
    fc.assert(
      fc.property(dagArb(1, MAX_TASKS), fc.nat(), (tasks, pick) => {
        const index = pick % tasks.length;
        const owner = tasks[index] as TaskDef;
        const mutated = patchAt(tasks, index, { role: "wizard" as unknown as Role });
        const errors = errorsOf(mutated);
        expect(errors.some((e) => e.startsWith(`task ${owner.id}:`))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("accepts a random graph iff it satisfies every structural rule (independent oracle)", () => {
    const idArb = fc.constantFrom("a", "b", "c", "d", "e", "f");
    const depArb = fc.constantFrom("a", "b", "c", "d", "e", "f", "zz");
    const countArb = fc.oneof(
      { weight: 8, arbitrary: checkCountArb },
      { weight: 1, arbitrary: fc.constantFrom(0, MAX_CHECKS + 1) },
    );
    const taskArb = fc.record({
      id: idArb,
      role: fc.oneof(
        { weight: 8, arbitrary: roleArb },
        { weight: 1, arbitrary: fc.constant("wizard") },
      ),
      dependsOn: fc.oneof(
        { weight: 3, arbitrary: fc.constant<string[]>([]) },
        { weight: 2, arbitrary: fc.array(depArb, { maxLength: 3 }) },
      ),
      count: countArb,
    });

    // Written without reference to validatePlan: iterative DFS colouring for the cycle test.
    const oracle = (tasks: { id: string; role: string; dependsOn: string[]; count: number }[]) => {
      if (tasks.length < 1 || tasks.length > MAX_TASKS) return false;
      const ids = new Set(tasks.map((t) => t.id));
      if (ids.size !== tasks.length) return false;
      for (const t of tasks) {
        if (!(ROLES as readonly string[]).includes(t.role)) return false;
        if (t.count < 1 || t.count > MAX_CHECKS) return false;
        if (t.dependsOn.some((d) => d === t.id || !ids.has(d))) return false;
      }
      const edges = new Map(tasks.map((t) => [t.id, t.dependsOn]));
      const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = finished
      const visit = (id: string): boolean => {
        if (state.get(id) === 2) return true;
        if (state.get(id) === 1) return false;
        state.set(id, 1);
        const ok = (edges.get(id) ?? []).every(visit);
        state.set(id, 2);
        return ok;
      };
      return tasks.every((t) => visit(t.id));
    };

    let accepted = 0;
    fc.assert(
      fc.property(fc.array(taskArb, { minLength: 0, maxLength: 5 }), (specs) => {
        const tasks = specs.map(
          (s): TaskDef => ({
            id: s.id,
            role: s.role as Role,
            dependsOn: s.dependsOn,
            acceptanceChecks: checksOf(s.count),
          }),
        );
        const result = validatePlan(tasks);
        if (result.ok) accepted += 1;
        expect(result.ok).toBe(oracle(specs));
      }),
      { numRuns: 1000 },
    );
    // The generator must actually hit the accepting side of the iff.
    expect(accepted).toBeGreaterThan(0);
  });
});
