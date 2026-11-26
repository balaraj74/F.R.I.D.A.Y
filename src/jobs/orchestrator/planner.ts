// Planner runtime (Requirements 7.1-7.4, 6.5): asks the Planner agent for a Task graph, rejects
// invalid output with recorded errors and asks for a corrected plan, up to 3 corrections.
import type { RunnerClock } from "../runner/deps.js";
import type { AppendedEvent, NewEvent } from "../store/types.js";
import { errorMessage, withTimeout } from "./async.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import { parsePlanOutput, type PlannedTask } from "./plan-parse.js";
import type { PlannerAgent } from "./runtime-types.js";

/** Planner time limit per attempt (Requirement 7.1). */
export const DEFAULT_PLAN_TIMEOUT_MS = 60_000;
/** Corrected plans requested after the first one is rejected (Requirement 7.2, 7.3). */
export const MAX_PLAN_CORRECTIONS = 3;
/** Longest failure reason stored on the Job. The full errors stay in the plan-rejected events. */
const MAX_REASON_CHARS = 500;

export type PlannerRuntime = {
  planner: PlannerAgent;
  clock: RunnerClock;
  appendEvent: (event: NewEvent) => AppendedEvent | void;
  planTimeoutMs: number;
};

export type PlanOutcome =
  | { ok: true; tasks: PlannedTask[]; attempts: number }
  | { ok: false; errors: string[]; attempts: number; reason: string };

/**
 * Produces a validated Task graph. Attempt 1 is the plan itself (or `initialPlan` when the
 * caller supplied one); attempts 2 to 4 are corrections that receive the previous errors.
 * A timeout, a planner error and invalid output each count as a rejected attempt. After the
 * last rejection the outcome is a failure and the caller must run no Task.
 */
export async function planJob(
  rt: PlannerRuntime,
  req: { jobId: string; goal: string; initialPlan?: unknown },
): Promise<PlanOutcome> {
  const maxAttempts = 1 + MAX_PLAN_CORRECTIONS;
  let previousErrors: string[] = [];
  let previousOutput: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: unknown;
    let errors: string[] | null = null;

    if (attempt === 1 && req.initialPlan !== undefined) {
      raw = req.initialPlan;
    } else {
      try {
        const result = await withTimeout(rt.clock, rt.planTimeoutMs, (signal) =>
          rt.planner({
            jobId: req.jobId,
            goal: req.goal,
            attempt,
            previousErrors,
            ...(previousOutput !== undefined ? { previousOutput } : {}),
            signal,
          }),
        );
        if (result.timedOut) {
          errors = [`planner did not return a plan within ${Math.round(rt.planTimeoutMs / 1000)}s`];
        } else {
          raw = result.value;
        }
      } catch (error) {
        errors = [`planner error: ${errorMessage(error)}`];
      }
    }

    if (errors === null) {
      const parsed = parsePlanOutput(raw);
      if (parsed.ok) {
        rt.appendEvent({
          jobId: req.jobId,
          type: ORCHESTRATOR_EVENT_TYPES.planAccepted,
          payload: { attempt, taskCount: parsed.tasks.length },
          createdAtMs: rt.clock.now(),
        });
        return { ok: true, tasks: parsed.tasks, attempts: attempt };
      }
      errors = parsed.errors;
    }

    rt.appendEvent({
      jobId: req.jobId,
      type: ORCHESTRATOR_EVENT_TYPES.planRejected,
      payload: { attempt, errors, willRetry: attempt < maxAttempts },
      createdAtMs: rt.clock.now(),
    });
    previousErrors = errors;
    previousOutput = raw;
  }

  const reason = `plan validation failed after ${maxAttempts} attempts: ${previousErrors.join("; ")}`;
  return {
    ok: false,
    errors: previousErrors,
    attempts: maxAttempts,
    reason:
      reason.length <= MAX_REASON_CHARS ? reason : `${reason.slice(0, MAX_REASON_CHARS - 1)}…`,
  };
}
