// Jobs_API: Gateway RPC methods for Jobs (Requirement 11).
//
// The handler functions are pure over an injectable `JobsApiDeps`, so tests run with an
// in-memory Event_Log and fakes. `createJobsApiDeps` adapts the real Orchestrator, and
// `createJobsApiHandlers` exposes the methods in the Gateway handler shape.
//
// Every request is validated, and every Job id and state change is checked, before any
// event is appended or any dep is called. Rejected requests therefore change nothing.
import type { DatabaseSync } from "node:sqlite";

import { type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { canTransition, requestTransition } from "../../jobs/engine/state-machine.js";
import { err, ok, type Result } from "../../jobs/engine/types.js";
import { formatDigestText, type DigestEntry } from "../../jobs/ops/digest.js";
import type { JobCreationGate } from "../../jobs/ops/health.js";
import type { CreateJobInput, Orchestrator } from "../../jobs/orchestrator/runtime-types.js";
import { EVENT_TYPES, loadEvents, projectJobState } from "../../jobs/store/index.js";
import type { AppendedEvent, JobRecord, JobState, TimelineEntry } from "../../jobs/store/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "../server-methods/types.js";
import {
  JOBS_API_METHODS,
  JobCreateParamsSchema,
  JobDigestParamsSchema,
  JobIdParamsSchema,
  JobListParamsSchema,
  LIST_PAGE_MAX,
  type JobControlResult,
  type JobCreateResult,
  type JobDetail,
  type JobDigestResult,
  type JobListResult,
  type JobReplayResult,
  type JobShowResult,
  type JobSummary,
  type JobTimelineEntry,
  type JobTraceEvent,
  type JobsApiError,
} from "./jobs.schema.js";

export * from "./jobs.schema.js";

export type JobsApiResult<T> = Result<T, JobsApiError>;

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

export interface JobsApiDeps {
  /** Event_Log database. Reads go straight to it; writes go through the callbacks below. */
  db: DatabaseSync;
  createJob(input: CreateJobInput): Promise<{ id: string }>;
  /** Called only after the API has checked the Job is in a state that allows the change. */
  pause(jobId: string): void | Promise<void>;
  resume(jobId: string): void | Promise<void>;
  cancel(jobId: string): void | Promise<void>;
  /** Health_Monitor gate. Absent means creation is always allowed (Req 13.7). */
  canCreateJob?(): JobCreationGate | Promise<JobCreationGate>;
  now?(): number;
}

/** Job lifecycle controls the Orchestrator exposes once task 12.6 lands. */
export type JobLifecycleControls = {
  pauseJob(jobId: string): void | Promise<void>;
  resumeJob(jobId: string): void | Promise<void>;
  cancelJob(jobId: string): void | Promise<void>;
};

/**
 * Wires the real Orchestrator. Where it does not (yet) provide pause/resume/cancel, the
 * change is recorded as a validated state transition in the Event_Log.
 */
export function createJobsApiDeps(opts: {
  db: DatabaseSync;
  orchestrator: Orchestrator & Partial<JobLifecycleControls>;
  canCreateJob?: JobsApiDeps["canCreateJob"];
  now?: () => number;
}): JobsApiDeps {
  const { db, orchestrator } = opts;
  const transition = (jobId: string, to: JobState, reason: string): void => {
    const res = requestTransition(db, jobId, to, {
      reason,
      ...(opts.now ? { nowMs: opts.now() } : {}),
    });
    if (!res.ok) throw new Error(`job ${jobId}: cannot move to ${to} (${res.error.kind})`);
  };
  return {
    db,
    createJob: (input) => orchestrator.createJob(input),
    pause: (id) =>
      orchestrator.pauseJob
        ? orchestrator.pauseJob(id)
        : transition(id, "paused", "paused via API"),
    resume: (id) =>
      orchestrator.resumeJob
        ? orchestrator.resumeJob(id)
        : transition(id, "running", "resumed via API"),
    cancel: (id) =>
      orchestrator.cancelJob
        ? orchestrator.cancelJob(id)
        : transition(id, "cancelled", "cancelled via API"),
    ...(opts.canCreateJob ? { canCreateJob: opts.canCreateJob } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Validation and projection helpers
// ---------------------------------------------------------------------------------------

function validationError(fields: string[], detail?: string): JobsApiError {
  const unique = [...new Set(fields)];
  return {
    code: "validation",
    message: `invalid request: ${detail ?? unique.join(", ")}`,
    field: unique[0] ?? "params",
    fields: unique.length > 0 ? unique : ["params"],
  };
}

/** Checks `params` against `schema`; the error names every invalid field. */
function validateParams<T extends TSchema>(
  schema: T,
  params: unknown,
  optionalParams = false,
): JobsApiResult<Static<T>> {
  const input = optionalParams && (params === undefined || params === null) ? {} : params;
  if (Value.Check(schema, input)) return ok(input as Static<T>);
  const issues = [...Value.Errors(schema, input)].map((e) => ({
    field: e.path.replace(/^\//, "").replaceAll("/", ".") || "params",
    message: e.message,
  }));
  const fields = issues.map((i) => i.field);
  const detail = [...new Map(issues.map((i) => [i.field, i])).values()]
    .map((i) => `${i.field} (${i.message})`)
    .join(", ");
  return err(validationError(fields, detail));
}

const notFound = (jobId: string): JobsApiError => ({
  code: "not_found",
  message: `job not found: ${jobId}`,
  jobId,
});

/** Only Jobs with a `job-created` event are Jobs. Other log owners (ops:health) are not. */
function isJob(record: JobRecord): boolean {
  return record.timeline.some((t) => t.type === EVENT_TYPES.jobCreated);
}

function loadJobs(db: DatabaseSync, jobId?: string): JobRecord[] {
  const projection = projectJobState(loadEvents(db, jobId));
  return Object.values(projection.jobs).filter(isJob);
}

function isoOrEpoch(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

// Stage names follow the `scope:phase` pattern of `CacheTraceStage` in src/agents/cache-trace.ts.
const STAGE_BY_EVENT_TYPE: Record<string, string> = {
  [EVENT_TYPES.jobCreated]: "job:created",
  [EVENT_TYPES.jobStateChanged]: "job:state",
  [EVENT_TYPES.taskCreated]: "task:created",
  [EVENT_TYPES.taskStateChanged]: "task:state",
  [EVENT_TYPES.stepStarted]: "step:started",
  [EVENT_TYPES.stepCompleted]: "step:completed",
  [EVENT_TYPES.stepFailed]: "step:failed",
  [EVENT_TYPES.leaseHeartbeat]: "lease:heartbeat",
  [EVENT_TYPES.leaseReclaimed]: "lease:reclaimed",
};
const stageFor = (type: string): string => STAGE_BY_EVENT_TYPE[type] ?? "job:event";

function toTraceEvent(e: AppendedEvent): JobTraceEvent {
  return {
    ts: isoOrEpoch(e.createdAtMs),
    seq: e.id,
    stage: stageFor(e.type),
    jobId: e.jobId,
    ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
    ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
    type: e.type,
    createdAtMs: e.createdAtMs,
    payload: e.payload,
  };
}

function toTimelineEntry(t: TimelineEntry): JobTimelineEntry {
  return {
    ts: isoOrEpoch(t.atMs),
    seq: t.eventId,
    stage: stageFor(t.type),
    type: t.type,
    ...(t.taskId !== undefined ? { taskId: t.taskId } : {}),
    ...(t.stepId !== undefined ? { stepId: t.stepId } : {}),
  };
}

function toSummary(job: JobRecord): JobSummary {
  return {
    id: job.id,
    ...(job.type !== undefined ? { type: job.type } : {}),
    ...(job.goal !== undefined ? { goal: job.goal } : {}),
    state: job.state,
    ...(job.stateReason !== undefined ? { stateReason: job.stateReason } : {}),
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    taskCount: Object.keys(job.tasks).length,
    usage: { ...job.usage },
  };
}

function toDetail(job: JobRecord): JobDetail {
  return {
    ...toSummary(job),
    tasks: Object.values(job.tasks).map((t) => ({
      id: t.id,
      ...(t.role !== undefined ? { role: t.role } : {}),
      dependsOn: [...t.dependsOn],
      state: t.state,
      ...(t.stateReason !== undefined ? { stateReason: t.stateReason } : {}),
      usage: { ...t.usage },
    })),
    timeline: job.timeline.map(toTimelineEntry),
  };
}

/** Newest first; Jobs created in the same millisecond order by id so pages are stable. */
function compareNewestFirst(a: JobRecord, b: JobRecord): number {
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function encodeCursor(job: JobRecord): string {
  return Buffer.from(JSON.stringify([job.createdAtMs, job.id])).toString("base64url");
}

function decodeCursor(cursor: string): [number, string] | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      Number.isSafeInteger(v[0]) &&
      typeof v[1] === "string"
    ) {
      return [v[0] as number, v[1]];
    }
  } catch {
    // Falls through to undefined.
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------------------

export async function createJob(
  deps: JobsApiDeps,
  params: unknown,
): Promise<JobsApiResult<JobCreateResult>> {
  const valid = validateParams(JobCreateParamsSchema, params);
  if (!valid.ok) return valid;
  const gate = await deps.canCreateJob?.();
  if (gate && !gate.allowed) {
    // Low disk blocks creation (Req 13.7). Reported as a validation error; nothing is written.
    return err({ code: "validation", message: gate.message });
  }
  const { id } = await deps.createJob({
    goal: valid.value.goal,
    ...(valid.value.type !== undefined ? { type: valid.value.type } : {}),
    ...(valid.value.concurrencyLimit !== undefined
      ? { concurrencyLimit: valid.value.concurrencyLimit }
      : {}),
  });
  const job = loadJobs(deps.db, id)[0];
  if (job) return ok({ job: toSummary(job) });
  // The creator did not write a job-created event (a fake, or a deferred write).
  const now = deps.now?.() ?? Date.now();
  return ok({
    job: {
      id,
      ...(valid.value.type !== undefined ? { type: valid.value.type } : {}),
      goal: valid.value.goal,
      state: "pending",
      createdAtMs: now,
      updatedAtMs: now,
      taskCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    },
  });
}

export function listJobs(deps: JobsApiDeps, params?: unknown): JobsApiResult<JobListResult> {
  const valid = validateParams(JobListParamsSchema, params, true);
  if (!valid.ok) return valid;
  const limit = Math.min(valid.value.limit ?? LIST_PAGE_MAX, LIST_PAGE_MAX);
  let jobs = loadJobs(deps.db).sort(compareNewestFirst);
  if (valid.value.cursor !== undefined) {
    const at = decodeCursor(valid.value.cursor);
    if (!at) return err(validationError(["cursor"], "cursor (not a cursor returned by job.list)"));
    const [createdAtMs, id] = at;
    jobs = jobs.filter(
      (j) => j.createdAtMs < createdAtMs || (j.createdAtMs === createdAtMs && j.id < id),
    );
  }
  const page = jobs.slice(0, limit);
  const hasMore = jobs.length > page.length;
  const last = page[page.length - 1];
  return ok({
    jobs: page.map(toSummary),
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
  });
}

export function showJob(deps: JobsApiDeps, params: unknown): JobsApiResult<JobShowResult> {
  const valid = validateParams(JobIdParamsSchema, params);
  if (!valid.ok) return valid;
  const job = loadJobs(deps.db, valid.value.jobId)[0];
  return job ? ok({ job: toDetail(job) }) : err(notFound(valid.value.jobId));
}

type ControlKind = "pause" | "resume" | "cancel";
const CONTROL_TARGET: Record<ControlKind, JobState> = {
  pause: "paused",
  resume: "running",
  cancel: "cancelled",
};

async function controlJob(
  deps: JobsApiDeps,
  kind: ControlKind,
  params: unknown,
): Promise<JobsApiResult<JobControlResult>> {
  const valid = validateParams(JobIdParamsSchema, params);
  if (!valid.ok) return valid;
  const { jobId } = valid.value;
  const job = loadJobs(deps.db, jobId)[0];
  if (!job) return err(notFound(jobId));
  // Resume is only valid from paused: `waiting_approval -> running` is the approval path,
  // not a resume.
  const allowed =
    canTransition(job.state, CONTROL_TARGET[kind]) && (kind !== "resume" || job.state === "paused");
  if (!allowed) {
    return err({
      code: "invalid_transition",
      message: `cannot ${kind} job ${jobId} while it is ${job.state}`,
      jobId,
      currentState: job.state,
    });
  }
  await deps[kind](jobId);
  const after = loadJobs(deps.db, jobId)[0] ?? job;
  return ok({ job: toSummary(after) });
}

export const pauseJob = (deps: JobsApiDeps, params: unknown) => controlJob(deps, "pause", params);
export const resumeJob = (deps: JobsApiDeps, params: unknown) => controlJob(deps, "resume", params);
export const cancelJob = (deps: JobsApiDeps, params: unknown) => controlJob(deps, "cancel", params);

/** Every event of the Job in ascending order of event timestamp (Req 11.3). */
export function replayJob(deps: JobsApiDeps, params: unknown): JobsApiResult<JobReplayResult> {
  const valid = validateParams(JobIdParamsSchema, params);
  if (!valid.ok) return valid;
  const { jobId } = valid.value;
  if (!loadJobs(deps.db, jobId)[0]) return err(notFound(jobId));
  // Event ids break timestamp ties, so equal timestamps keep their append order.
  const events = loadEvents(deps.db, jobId).sort(
    (a, b) => a.createdAtMs - b.createdAtMs || a.id - b.id,
  );
  return ok({ jobId, events: events.map(toTraceEvent) });
}

/** Jobs whose status changed after `sinceMs` (all Jobs when absent), oldest change first. */
export function digestJobs(deps: JobsApiDeps, params?: unknown): JobsApiResult<JobDigestResult> {
  const valid = validateParams(JobDigestParamsSchema, params, true);
  if (!valid.ok) return valid;
  const since = valid.value.sinceMs ?? -Infinity;
  const entries: DigestEntry[] = [];
  for (const job of loadJobs(deps.db)) {
    let changedAtMs: number | undefined;
    for (const t of job.timeline) {
      if (t.type === EVENT_TYPES.jobCreated || t.type === EVENT_TYPES.jobStateChanged) {
        changedAtMs = Math.max(changedAtMs ?? t.atMs, t.atMs);
      }
    }
    if (changedAtMs === undefined || changedAtMs <= since) continue;
    const terminal = job.state === "done" || job.state === "failed" || job.state === "cancelled";
    entries.push({
      jobId: job.id,
      status: job.state,
      ...(terminal ? { completedAtMs: changedAtMs } : {}),
      changedAtMs,
    });
  }
  entries.sort((a, b) => a.changedAtMs - b.changedAtMs || (a.jobId < b.jobId ? -1 : 1));
  return ok({
    entries: entries as JobDigestResult["entries"],
    text: formatDigestText(entries),
    generatedAtMs: deps.now?.() ?? Date.now(),
  });
}

// ---------------------------------------------------------------------------------------
// Gateway registration
// ---------------------------------------------------------------------------------------

export const JOBS_API_READ_METHODS: readonly string[] = [
  JOBS_API_METHODS.list,
  JOBS_API_METHODS.show,
  JOBS_API_METHODS.replay,
  JOBS_API_METHODS.digest,
];
export const JOBS_API_WRITE_METHODS: readonly string[] = [
  JOBS_API_METHODS.create,
  JOBS_API_METHODS.pause,
  JOBS_API_METHODS.resume,
  JOBS_API_METHODS.cancel,
];

/**
 * Gateway handlers for the Jobs_API. `getDeps` is called per request so the Gateway can
 * supply the Orchestrator and Event_Log once they are available. A Jobs_API error is sent
 * as an INVALID_REQUEST error whose `details` is the `JobsApiError`.
 */
export function createJobsApiHandlers(
  getDeps: () => JobsApiDeps | Promise<JobsApiDeps>,
): GatewayRequestHandlers {
  const wrap =
    (
      run: (
        deps: JobsApiDeps,
        params: unknown,
      ) => JobsApiResult<unknown> | Promise<JobsApiResult<unknown>>,
    ) =>
    async ({
      params,
      respond,
    }: {
      params: unknown;
      respond: (ok: boolean, payload?: unknown, error?: ReturnType<typeof errorShape>) => void;
    }) => {
      try {
        const res = await run(await getDeps(), params);
        if (res.ok) respond(true, res.value, undefined);
        else
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, res.error.message, { details: res.error }),
          );
      } catch (e) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, e instanceof Error ? e.message : String(e)),
        );
      }
    };
  return {
    [JOBS_API_METHODS.create]: wrap(createJob),
    [JOBS_API_METHODS.list]: wrap(listJobs),
    [JOBS_API_METHODS.show]: wrap(showJob),
    [JOBS_API_METHODS.pause]: wrap(pauseJob),
    [JOBS_API_METHODS.resume]: wrap(resumeJob),
    [JOBS_API_METHODS.cancel]: wrap(cancelJob),
    [JOBS_API_METHODS.replay]: wrap(replayJob),
    [JOBS_API_METHODS.digest]: wrap(digestJobs),
  };
}
