import type { DatabaseSync } from "node:sqlite";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  appendEvent,
  EVENT_TYPES,
  loadEvents,
  projectJobState,
  type AppendedEvent,
  type JobRecord,
} from "../store/index.js";
import { TERMINAL_JOB_STATES } from "./state-machine.js";

const log = createSubsystemLogger("jobs/engine");

/** Resume must begin within this long after the Gateway restarts (Req 5.11). */
export const RESUME_WINDOW_MS = 60_000;

/** One interrupted Step handed to the injected resume callback. */
export type ResumeStepRequest = {
  jobId: string;
  stepId: string;
  taskId?: string;
  /** True when this boot appended a `lease-reclaimed` event for the Step. */
  reclaimed: boolean;
  /** Resume should have started by this time (boot time + 60s, Req 5.11). */
  resumeByMs: number;
};

/** Plugged in by the Step_Runner. May be async; a rejection is logged, not thrown. */
export type ResumeStepFn = (req: ResumeStepRequest) => void | Promise<void>;

export type RestoreJobEngineOptions = {
  /** Called once per interrupted Step. Without it the restore only reclaims leases. */
  resumeStep?: ResumeStepFn;
  /** Boot time; defaults to `Date.now()`. */
  bootTimeMs?: number;
};

export type RestoreJobEngineResult = {
  reclaimed: AppendedEvent[];
  resumed: ResumeStepRequest[];
};

// `var` mirrors subagent-registry.ts: avoids a TDZ error if init runs across circular imports.
// oxlint-disable-next-line no-var
var restoreAttempted = false;

/** Test helper: lets a test run `restoreJobEngineOnce` again. */
export function resetJobEngineRestoreForTests(): void {
  restoreAttempted = false;
}

/**
 * Finds every Step still `running` whose Lease expired before `bootTimeMs` and appends one
 * `lease-reclaimed` event per Step (Req 5.9). Steps with an unexpired Lease, no Lease
 * information, or any other status get no event. Running it twice appends nothing the
 * second time, because the first run moves each Step out of `running`.
 * A failed append is logged and skipped; that Step is reclaimed on the next boot.
 */
export function reclaimStaleLeases(db: DatabaseSync, bootTimeMs: number): AppendedEvent[] {
  const projection = projectJobState(loadEvents(db));
  const appended: AppendedEvent[] = [];
  for (const job of Object.values(projection.jobs)) {
    for (const step of Object.values(job.steps)) {
      if (step.status !== "running" || step.lease === undefined) continue;
      if (!(step.lease.expiresAtMs < bootTimeMs)) continue;
      try {
        appended.push(
          appendEvent(db, {
            jobId: job.id,
            ...(step.taskId !== undefined ? { taskId: step.taskId } : {}),
            stepId: step.id,
            type: EVENT_TYPES.leaseReclaimed,
            payload: { expiredAtMs: step.lease.expiresAtMs, bootTimeMs },
            createdAtMs: bootTimeMs,
          }),
        );
      } catch (e) {
        log.warn(`failed to reclaim lease for step ${step.id} of job ${job.id}: ${String(e)}`);
      }
    }
  }
  return appended;
}

/** Step ids in the order they first appear in the Job's log. */
function stepOrder(job: JobRecord): string[] {
  const seen = new Set<string>();
  for (const entry of job.timeline) {
    if (entry.stepId !== undefined && job.steps[entry.stepId] !== undefined) {
      seen.add(entry.stepId);
    }
  }
  return [...seen];
}

/**
 * Interrupted Steps to resume, in log order. A Step is interrupted when it is still
 * `running` or was `reclaimed`; `completed` Steps are never returned (Req 5.11), and a
 * `failed` Step is a recorded outcome the Step_Runner already handled. Terminal, paused and
 * approval-blocked Jobs are skipped because they are not meant to make progress.
 */
function collectResumable(
  jobs: Record<string, JobRecord>,
  reclaimedIds: ReadonlySet<string>,
  resumeByMs: number,
): ResumeStepRequest[] {
  const out: ResumeStepRequest[] = [];
  for (const job of Object.values(jobs)) {
    if (TERMINAL_JOB_STATES.includes(job.state)) continue;
    if (job.state === "paused" || job.state === "waiting_approval") continue;
    for (const stepId of stepOrder(job)) {
      const step = job.steps[stepId];
      if (!step || (step.status !== "running" && step.status !== "reclaimed")) continue;
      out.push({
        jobId: job.id,
        stepId,
        ...(step.taskId !== undefined ? { taskId: step.taskId } : {}),
        reclaimed: reclaimedIds.has(`${job.id}\u0000${stepId}`),
        resumeByMs,
      });
    }
  }
  return out;
}

/**
 * Gateway-boot restore for the Job_Engine, following `restoreSubagentRunsOnce` in
 * `src/agents/subagent-registry.ts` (Req 5.13): runs at most once per process, loads the
 * persisted Event_Log, reclaims stale Leases, then hands each interrupted Step to
 * `resumeStep`. Any failure is logged and swallowed so it cannot crash Gateway boot.
 */
export function restoreJobEngineOnce(
  db: DatabaseSync,
  opts: RestoreJobEngineOptions = {},
): RestoreJobEngineResult {
  const result: RestoreJobEngineResult = { reclaimed: [], resumed: [] };
  if (restoreAttempted) return result;
  restoreAttempted = true;
  try {
    const bootTimeMs = opts.bootTimeMs ?? Date.now();
    result.reclaimed = reclaimStaleLeases(db, bootTimeMs);
    const reclaimedIds = new Set(result.reclaimed.map((e) => `${e.jobId}\u0000${e.stepId}`));

    // Re-project after reclaiming so reclaimed Steps are seen with their new status.
    const { jobs } = projectJobState(loadEvents(db));
    const pending = collectResumable(jobs, reclaimedIds, bootTimeMs + RESUME_WINDOW_MS);
    for (const req of pending) {
      if (!opts.resumeStep) break;
      try {
        // Not awaited: a Step can run for minutes and must not delay the others.
        void Promise.resolve(opts.resumeStep(req)).catch((e: unknown) => {
          log.warn(`resume of step ${req.stepId} (job ${req.jobId}) failed: ${String(e)}`);
        });
        result.resumed.push(req);
      } catch (e) {
        log.warn(`resume of step ${req.stepId} (job ${req.jobId}) failed: ${String(e)}`);
      }
    }
  } catch (e) {
    log.warn(`job engine restore failed: ${String(e)}`);
  }
  return result;
}
