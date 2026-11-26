import type { TaskDef, TaskState } from "./types.js";

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

export function isValidConcurrencyLimit(limit: unknown): limit is number {
  return (
    typeof limit === "number" &&
    Number.isInteger(limit) &&
    limit >= MIN_CONCURRENCY &&
    limit <= MAX_CONCURRENCY
  );
}

/**
 * Ids of Tasks that have not started and whose dependencies are all done (Requirement 7.6).
 * A Task missing from `state` counts as pending. Tasks depending on a failed, skipped or
 * waiting Task are never ready, which is what blocks dependents transitively (Req 7.11, 8.2).
 */
export function readyTasks(
  tasks: readonly TaskDef[],
  state: Readonly<Record<string, TaskState>>,
): string[] {
  return tasks
    .filter((task) => (state[task.id] ?? "pending") === "pending")
    .filter((task) => task.dependsOn.every((dep) => state[dep] === "done"))
    .map((task) => task.id);
}

/**
 * Picks which ready Tasks to start now. Never returns more than
 * `concurrencyLimit - runningCount`, preserving the order of `ready` so earlier
 * Tasks win when a slot frees up.
 */
export function schedule(
  ready: readonly string[],
  runningCount: number,
  concurrencyLimit: number,
): string[] {
  if (!isValidConcurrencyLimit(concurrencyLimit)) {
    throw new RangeError(
      `concurrency limit must be an integer ${MIN_CONCURRENCY}-${MAX_CONCURRENCY}, got ${String(concurrencyLimit)}`,
    );
  }
  const slots = Math.max(0, concurrencyLimit - Math.max(0, runningCount));
  return [...new Set(ready)].slice(0, slots);
}
