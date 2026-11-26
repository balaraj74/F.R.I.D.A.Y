import { ROLES, type TaskDef } from "./types.js";

export const MIN_TASKS = 1;
export const MAX_TASKS = 50;
export const MIN_CHECKS = 1;
export const MAX_CHECKS = 10;

export type PlanValidation = { ok: true } | { ok: false; errors: string[] };

const isRole = (value: unknown): boolean => ROLES.some((r) => r === value);

/**
 * Structural validation of a Planner output (Requirements 7.1, 7.4).
 * Every error message that concerns a specific Task contains that Task's id.
 */
export function validatePlan(tasks: readonly TaskDef[]): PlanValidation {
  const errors: string[] = [];

  if (tasks.length < MIN_TASKS || tasks.length > MAX_TASKS) {
    errors.push(`plan must contain ${MIN_TASKS}-${MAX_TASKS} tasks, got ${tasks.length}`);
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    seen.add(task.id);
  }
  for (const id of duplicates) errors.push(`task ${id}: duplicate id`);

  for (const task of tasks) {
    if (!isRole(task.role)) errors.push(`task ${task.id}: invalid role`);
    const checks = task.acceptanceChecks.length;
    if (checks < MIN_CHECKS || checks > MAX_CHECKS) {
      errors.push(
        `task ${task.id}: must have ${MIN_CHECKS}-${MAX_CHECKS} acceptance checks, got ${checks}`,
      );
    }
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`task ${task.id}: depends on itself`);
      else if (!seen.has(dep)) errors.push(`task ${task.id}: depends on unknown task ${dep}`);
    }
  }

  for (const id of findCycleMembers(tasks, seen)) {
    errors.push(`task ${id}: part of a dependency cycle`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Kahn's algorithm over the valid edges only (self and unknown edges are reported
 * separately). Tasks left with unresolved dependencies after the sort lie on a cycle or
 * depend on one, so only the ones that can still reach themselves are reported.
 */
function findCycleMembers(tasks: readonly TaskDef[], ids: ReadonlySet<string>): string[] {
  const deps = new Map<string, Set<string>>();
  for (const task of tasks) {
    const edges = deps.get(task.id) ?? new Set<string>();
    for (const dep of task.dependsOn) if (dep !== task.id && ids.has(dep)) edges.add(dep);
    deps.set(task.id, edges);
  }

  const remaining = new Map(deps);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, edges] of remaining) {
      if ([...edges].every((dep) => !remaining.has(dep))) {
        remaining.delete(id);
        progressed = true;
      }
    }
  }

  // Keep only tasks that are on a cycle themselves, not merely downstream of one.
  const members: string[] = [];
  for (const id of remaining.keys()) {
    if (reaches(id, id, remaining)) members.push(id);
  }
  return members;
}

function reaches(from: string, target: string, graph: ReadonlyMap<string, Set<string>>): boolean {
  const visited = new Set<string>();
  const stack = [...(graph.get(from) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of graph.get(current) ?? []) stack.push(next);
  }
  return false;
}
