/**
 * Scheduler (Requirement 13.1). Creates exactly one operations Job (inbox handling, monitoring or
 * daily report) for each scheduled time of each configured schedule.
 *
 * The timer is an injectable `SchedulerTimer`. `createCronTimer` is the adapter over `src/cron/`:
 * it registers one recurring CronJob per schedule and turns the cron system event back into a tick,
 * so nothing in `src/cron/` changes. Job creation is an injectable `createJob` (normally
 * `createOrchestrator(...).createJob`), and the clock is injectable.
 *
 * Idempotency: a tick is identified by the dedupe key `ops:<scheduleId>:<scheduledAtMs>`. The key is
 * written into the Job goal (the Orchestrator records the goal in the `job-created` event), and a tick
 * first looks for an existing `job-created` event carrying that key. A duplicate tick, or a tick
 * replayed after a Gateway restart, therefore finds the first Job and creates nothing. Concurrent
 * ticks for the same key share one in-flight creation.
 */
import { computeNextRunAtMs } from "../../cron/schedule.js";
import type { CronJob, CronJobCreate, CronSchedule } from "../../cron/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { errorMessage } from "../orchestrator/async.js";
import type { DatabaseSync } from "node:sqlite";
import { loadEvents } from "../store/log.js";
import { EVENT_TYPES } from "../store/project.js";
import type { JobType } from "../store/types.js";

const log = createSubsystemLogger("jobs/ops/scheduler");

export const OPS_JOB_KINDS = ["inbox-handling", "monitoring", "daily-report"] as const;
export type OpsJobKind = (typeof OPS_JOB_KINDS)[number];

/** Requirement 13.1: the Job must exist within this long after the scheduled time. */
export const SCHEDULER_DEADLINE_MS = 60_000;

/** How far back `createCronTimer` looks for the scheduled time behind a cron fire. */
export const DEFAULT_LOOKBACK_MS = 10 * 60_000;

const DEFAULT_GOALS: Record<OpsJobKind, string> = {
  "inbox-handling": "Operations: handle the inbox (triage new messages and draft replies).",
  monitoring: "Operations: run the monitoring checks and report anything abnormal.",
  "daily-report": "Operations: compile the daily report of activity since the previous report.",
};

export type OpsSchedule = {
  /** Stable identifier, part of the dedupe key. Letters, digits, `.`, `_`, `-`. */
  id: string;
  kind: OpsJobKind;
  schedule: CronSchedule;
  /** Overrides the default goal text for the kind. */
  goal?: string;
};

/** One scheduled occurrence. `scheduledAtMs` is the scheduled time, not the time the timer fired. */
export type ScheduleTick = { scheduleId: string; scheduledAtMs: number };

export type TickHandler = (tick: ScheduleTick) => void | Promise<void>;

/** Timer abstraction. `start` returns a function that stops the schedule. */
export interface SchedulerTimer {
  start(schedule: OpsSchedule, onTick: TickHandler): Promise<() => Promise<void> | void>;
}

export type SchedulerClock = { now(): number };

export type CreateOpsJob = (input: { goal: string; type: JobType }) => Promise<{ id: string }>;

export type SchedulerDeps = {
  /** Event_Log database, read to find an existing Job for a tick. */
  db: DatabaseSync;
  /** Normally `createOrchestrator(...).createJob`. */
  createJob: CreateOpsJob;
  timer: SchedulerTimer;
  schedules: readonly OpsSchedule[];
  clock?: SchedulerClock;
};

export type TickResult =
  | { status: "created"; key: string; jobId: string; lateMs: number }
  | { status: "duplicate"; key: string; jobId: string }
  | { status: "failed"; key: string; error: string }
  | { status: "ignored"; reason: "unknown-schedule" };

export interface Scheduler {
  /** Registers every schedule with the timer. */
  start(): Promise<void>;
  /** Stops every registered schedule. Ticks already in flight still finish. */
  stop(): Promise<void>;
  /** Processes one tick. Safe to call twice for the same tick. */
  handleTick(tick: ScheduleTick): Promise<TickResult>;
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function dedupeKey(scheduleId: string, scheduledAtMs: number): string {
  return `ops:${scheduleId}:${scheduledAtMs}`;
}

/** The line appended to the goal. The closing bracket makes one key never a prefix of another. */
function keyMarker(key: string): string {
  return `[schedule-key: ${key}]`;
}

function buildGoal(s: OpsSchedule, key: string): string {
  return `${s.goal?.trim() || DEFAULT_GOALS[s.kind]}\n\n${keyMarker(key)}`;
}

/** Returns the id of the Job already created for `key`, if the Event_Log has one. */
export function findJobForKey(db: DatabaseSync, key: string): string | undefined {
  const marker = keyMarker(key);
  for (const e of loadEvents(db)) {
    if (e.type !== EVENT_TYPES.jobCreated) continue;
    const goal = (e.payload as { goal?: unknown } | null)?.goal;
    if (typeof goal === "string" && goal.includes(marker)) return e.jobId;
  }
  return undefined;
}

function validateSchedules(schedules: readonly OpsSchedule[]): Map<string, OpsSchedule> {
  const byId = new Map<string, OpsSchedule>();
  for (const s of schedules) {
    if (typeof s.id !== "string" || !ID_PATTERN.test(s.id)) {
      throw new TypeError(`invalid schedule id ${JSON.stringify(s.id)}`);
    }
    if (!OPS_JOB_KINDS.includes(s.kind)) {
      throw new TypeError(`schedule ${s.id}: unknown kind ${JSON.stringify(s.kind)}`);
    }
    if (byId.has(s.id)) throw new TypeError(`duplicate schedule id ${s.id}`);
    byId.set(s.id, s);
  }
  return byId;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const clock = deps.clock ?? { now: () => Date.now() };
  const byId = validateSchedules(deps.schedules);
  const inFlight = new Map<string, Promise<TickResult>>();
  const stops: Array<() => Promise<void> | void> = [];

  async function process(s: OpsSchedule, tick: ScheduleTick, key: string): Promise<TickResult> {
    try {
      const existing = findJobForKey(deps.db, key);
      if (existing !== undefined) return { status: "duplicate", key, jobId: existing };
      const { id } = await deps.createJob({ goal: buildGoal(s, key), type: "operations" });
      return {
        status: "created",
        key,
        jobId: id,
        lateMs: Math.max(0, clock.now() - tick.scheduledAtMs),
      };
    } catch (error) {
      // Nothing was recorded for this key, so a later retry of the same tick creates the Job.
      log.error(`schedule ${s.id}: could not create Job for ${key}: ${errorMessage(error)}`);
      return { status: "failed", key, error: errorMessage(error) };
    }
  }

  function handleTick(tick: ScheduleTick): Promise<TickResult> {
    const s = byId.get(tick.scheduleId);
    if (!s || !Number.isSafeInteger(tick.scheduledAtMs)) {
      return Promise.resolve({ status: "ignored", reason: "unknown-schedule" });
    }
    const key = dedupeKey(s.id, tick.scheduledAtMs);
    const pending = inFlight.get(key);
    if (pending) {
      // A concurrent tick for the same key: wait for the first and report it as a duplicate.
      return pending.then((r) =>
        r.status === "created" ? { status: "duplicate", key, jobId: r.jobId } : r,
      );
    }
    const run = process(s, tick, key).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  return {
    handleTick,
    async start() {
      for (const s of byId.values()) {
        stops.push(await deps.timer.start(s, (tick) => void handleTick(tick)));
      }
    },
    async stop() {
      const toStop = stops.splice(0);
      for (const stop of toStop) await stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cron adapter
// ---------------------------------------------------------------------------------------------

/** Latest scheduled time at or before `firedAtMs`, or undefined when none is found. */
export function resolveScheduledAtMs(
  schedule: CronSchedule,
  firedAtMs: number,
  lookbackMs = DEFAULT_LOOKBACK_MS,
): number | undefined {
  if (schedule.kind === "at") return schedule.atMs <= firedAtMs ? schedule.atMs : undefined;
  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    // Without an anchor, align to the epoch so the slot is the same after a restart.
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? 0));
    if (firedAtMs < anchor) return undefined;
    return anchor + Math.floor((firedAtMs - anchor) / everyMs) * everyMs;
  }
  // computeNextRunAtMs returns the first occurrence strictly after its argument.
  let cursor = firedAtMs - lookbackMs;
  let last: number | undefined;
  for (let i = 0; i < 10_000; i++) {
    const next = computeNextRunAtMs(schedule, cursor);
    if (next === undefined || next > firedAtMs) break;
    last = next;
    cursor = next;
  }
  return last;
}

/** The slice of `CronService` the adapter uses. */
export interface CronLike {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]>;
  add(input: CronJobCreate): Promise<CronJob>;
  remove(id: string): Promise<unknown>;
}

const CRON_NAME_PREFIX = "friday-ops:";
const CRON_TEXT_PREFIX = "friday-ops-tick:";

export type CronTimer = {
  timer: SchedulerTimer;
  /**
   * Call from the CronService `enqueueSystemEvent` dependency with the event text and the time it
   * fired. Returns true when the text belonged to this adapter (the host should not forward it).
   */
  handleSystemEvent(text: string, firedAtMs?: number): boolean;
};

export function createCronTimer(
  cron: CronLike,
  opts: { clock?: SchedulerClock; lookbackMs?: number } = {},
): CronTimer {
  const clock = opts.clock ?? { now: () => Date.now() };
  const handlers = new Map<string, { schedule: OpsSchedule; onTick: TickHandler }>();

  return {
    timer: {
      async start(schedule, onTick) {
        const name = `${CRON_NAME_PREFIX}${schedule.id}`;
        // The cron store persists across restarts, so reuse a matching job instead of adding another.
        const existing = (await cron.list({ includeDisabled: true })).filter(
          (j) => j.name === name,
        );
        const reusable = existing.find(
          (j) => j.enabled && JSON.stringify(j.schedule) === JSON.stringify(schedule.schedule),
        );
        for (const j of existing) if (j !== reusable) await cron.remove(j.id);
        const job =
          reusable ??
          (await cron.add({
            name,
            description: `FRIDAY operations schedule ${schedule.id} (${schedule.kind})`,
            enabled: true,
            schedule: schedule.schedule,
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "systemEvent", text: `${CRON_TEXT_PREFIX}${schedule.id}` },
          }));
        handlers.set(schedule.id, { schedule, onTick });
        return async () => {
          handlers.delete(schedule.id);
          await cron.remove(job.id);
        };
      },
    },
    handleSystemEvent(text, firedAtMs = clock.now()) {
      if (!text.startsWith(CRON_TEXT_PREFIX)) return false;
      const entry = handlers.get(text.slice(CRON_TEXT_PREFIX.length).trim());
      if (!entry) return true;
      const scheduledAtMs =
        resolveScheduledAtMs(entry.schedule.schedule, firedAtMs, opts.lookbackMs) ??
        // No occurrence found: fall back to the fire second so a double fire still dedupes.
        Math.floor(firedAtMs / 1000) * 1000;
      void Promise.resolve(entry.onTick({ scheduleId: entry.schedule.id, scheduledAtMs })).catch(
        (error) => log.error(`tick handler failed: ${errorMessage(error)}`),
      );
      return true;
    },
  };
}
