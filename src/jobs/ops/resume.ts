/**
 * Resume after a reboot (Requirement 13.10). When the Gateway starts, `resumeAfterBoot` reclaims the
 * Leases the dead process held, then hands every Job that was still running to the Orchestrator's
 * `adoptJob`. Each Job continues from its first Step that had not completed; completed Steps are
 * never run again. Adoption starts every Job at once, so resume begins right at Gateway start,
 * well inside the 60s allowed. The result says whether that deadline was met.
 *
 * Paused and approval-blocked Jobs are left alone on purpose. Clock, notifier and the Orchestrator
 * are injected.
 */
import type { DatabaseSync } from "node:sqlite";

import { RESUME_WINDOW_MS, restoreJobEngineOnce } from "../engine/boot.js";
import { TERMINAL_JOB_STATES } from "../engine/state-machine.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AdoptJobResult, Orchestrator } from "../orchestrator/runtime-types.js";
import { EVENT_TYPES, loadEvents, projectJobState, type AppendedEvent } from "../store/index.js";
import { HEALTH_EVENT_JOB_ID } from "./health.js";

const log = createSubsystemLogger("jobs/resume");

export type ResumeAfterBootDeps = {
  /** Event_Log database holding the Jobs of the previous process. */
  db: DatabaseSync;
  orchestrator: Pick<Orchestrator, "adoptJob">;
  clock?: { now(): number };
  /** Gateway start time. Defaults to `clock.now()`. */
  bootTimeMs?: number;
  /** Told when a Job could not be taken over. `Notifier` satisfies this. */
  notifier?: { notify(text: string): unknown };
};

export type ResumeAfterBootResult = {
  bootTimeMs: number;
  /** Resume must have started by this time: boot time plus 60s (Req 13.10). */
  deadlineMs: number;
  startedAtMs: number;
  completedAtMs: number;
  /** True when every Job was taken over by the deadline. */
  withinDeadline: boolean;
  /** `lease-reclaimed` events appended by the boot restore. */
  reclaimed: AppendedEvent[];
  adopted: Array<Extract<AdoptJobResult, { ok: true }>>;
  /** Jobs left alone, e.g. paused, or refused by `adoptJob`. */
  skipped: Array<{ jobId: string; reason: string }>;
  /** Jobs whose adoption threw. */
  failed: Array<{ jobId: string; error: string }>;
};

/** Ids of Jobs a reboot interrupted, oldest first. Health and other non-Job log owners are excluded. */
export function listInterruptedJobIds(db: DatabaseSync): string[] {
  const { jobs } = projectJobState(loadEvents(db));
  return Object.values(jobs)
    .filter(
      (job) =>
        job.id !== HEALTH_EVENT_JOB_ID &&
        !job.id.startsWith("ops:") &&
        job.timeline.some((e) => e.type === EVENT_TYPES.jobCreated) &&
        !TERMINAL_JOB_STATES.includes(job.state) &&
        job.state !== "paused" &&
        job.state !== "waiting_approval",
    )
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
    .map((job) => job.id);
}

export async function resumeAfterBoot(deps: ResumeAfterBootDeps): Promise<ResumeAfterBootResult> {
  const clock = deps.clock ?? { now: () => Date.now() };
  const bootTimeMs = deps.bootTimeMs ?? clock.now();
  const deadlineMs = bootTimeMs + RESUME_WINDOW_MS;
  const startedAtMs = clock.now();

  // Reclaims expired Leases. Adoption releases any Lease that has not expired yet.
  const restored = restoreJobEngineOnce(deps.db, { bootTimeMs });

  const result: ResumeAfterBootResult = {
    bootTimeMs,
    deadlineMs,
    startedAtMs,
    completedAtMs: startedAtMs,
    withinDeadline: true,
    reclaimed: restored.reclaimed,
    adopted: [],
    skipped: [],
    failed: [],
  };

  let jobIds: string[] = [];
  try {
    jobIds = listInterruptedJobIds(deps.db);
  } catch (e) {
    log.warn(`could not list interrupted jobs: ${String(e)}`);
  }

  // Started together so one slow Job cannot push another past the deadline.
  type Outcome = { jobId: string; res: AdoptJobResult } | { jobId: string; error: string };
  const outcomes = await Promise.all(
    jobIds.map(async (jobId): Promise<Outcome> => {
      try {
        return { jobId, res: await deps.orchestrator.adoptJob(jobId) };
      } catch (e) {
        return { jobId, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  for (const o of outcomes) {
    if ("error" in o) {
      result.failed.push({ jobId: o.jobId, error: o.error });
      await tell(deps, `Job ${o.jobId} could not be resumed after the restart: ${o.error}`);
    } else if (o.res.ok) {
      result.adopted.push(o.res);
    } else {
      result.skipped.push({ jobId: o.jobId, reason: o.res.reason });
    }
  }

  result.completedAtMs = clock.now();
  result.withinDeadline = result.completedAtMs <= deadlineMs;
  if (!result.withinDeadline) {
    log.warn(`job resume finished ${result.completedAtMs - deadlineMs}ms after the 60s deadline`);
  }
  return result;
}

async function tell(deps: ResumeAfterBootDeps, text: string): Promise<void> {
  try {
    await deps.notifier?.notify(text);
  } catch (e) {
    log.warn(`could not notify: ${String(e)}`);
  }
}
