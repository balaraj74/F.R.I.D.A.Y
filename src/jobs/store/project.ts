import {
  JOB_STATES,
  TASK_STATES,
  type AppendedEvent,
  type JobProjection,
  type JobRecord,
  type JobState,
  type JobType,
  type StepProjection,
  type TaskState,
  type UsageTotals,
} from "./types.js";

/**
 * Event types the projection understands. Any other type still appears in the timeline
 * but does not change Job, Task or Step state, so new event types never break replay.
 */
export const EVENT_TYPES = {
  jobCreated: "job-created", // payload: { type?, goal?, branch? }
  jobStateChanged: "job-state-changed", // payload: { to, reason? }
  taskCreated: "task-created", // taskId; payload: { role?, dependsOn?, acceptanceChecks? }
  taskStateChanged: "task-state-changed", // taskId; payload: { to, reason? }
  stepStarted: "step-started", // stepId, taskId?; payload: { model?, leaseExpiresAtMs? }
  leaseHeartbeat: "lease-heartbeat", // stepId; payload: { expiresAtMs }
  leaseReclaimed: "lease-reclaimed", // stepId
  // stepId; payload: { inputTokens?, outputTokens?, elapsedMs?, taskId?, agentId? } (Req 10.7)
  stepCompleted: "step-completed",
  // stepId; payload: { reason?, inputTokens?, outputTokens?, elapsedMs?, taskId?, agentId? }
  stepFailed: "step-failed",
} as const;

const JOB_TYPES: readonly string[] = ["coding", "research", "operations"];

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Non-numeric, non-finite or negative values count as 0 (Req 10.7). */
function amount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Bucket in `agentUsage` for step events that name no agent. */
export const UNKNOWN_AGENT = "unknown";

function zeroUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 };
}

function addUsage(into: UsageTotals, d: UsageTotals): void {
  into.inputTokens += d.inputTokens;
  into.outputTokens += d.outputTokens;
  into.totalTokens += d.totalTokens;
  into.elapsedMs += d.elapsedMs;
}

/**
 * Folds one step-completed / step-failed event into Step, Task, agent and Job accounting.
 * Task and Job totals are bumped by the same delta, so sum(task totals) == job total
 * (Req 10.8) holds for any event sequence. An event with no resolvable Task goes to
 * `unattributedUsage` instead of the Job total.
 */
function accountStep(
  job: JobRecord,
  step: StepProjection,
  e: AppendedEvent,
  p: Record<string, unknown>,
): void {
  const inputTokens = amount(p.inputTokens);
  const outputTokens = amount(p.outputTokens);
  const delta: UsageTotals = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    elapsedMs: amount(p.elapsedMs),
  };
  const agentId = str(p.agentId);
  if (agentId !== undefined) step.agentId = agentId;
  addUsage(step.usage, delta);

  const taskId = e.taskId ?? str(p.taskId) ?? step.taskId;
  const hasUsage = delta.totalTokens > 0 || delta.elapsedMs > 0;
  const task = taskId === undefined ? undefined : job.tasks[taskId];
  if (taskId === undefined || (task === undefined && !hasUsage)) {
    // Nothing to attribute: do not invent a Task for a zero-valued event.
    if (taskId === undefined) addUsage(job.unattributedUsage, delta);
    return;
  }
  addUsage((task ?? ensureTask(job, taskId)).usage, delta);
  addUsage(job.usage, delta);
  addUsage((job.agentUsage[step.agentId ?? UNKNOWN_AGENT] ??= zeroUsage()), delta);
}

function emptyJob(id: string, atMs: number): JobRecord {
  return {
    id,
    state: "pending",
    createdAtMs: atMs,
    updatedAtMs: atMs,
    tasks: {},
    steps: {},
    usage: zeroUsage(),
    agentUsage: {},
    unattributedUsage: zeroUsage(),
    timeline: [],
  };
}

function ensureTask(job: JobRecord, taskId: string) {
  return (job.tasks[taskId] ??= {
    id: taskId,
    jobId: job.id,
    dependsOn: [],
    acceptanceChecks: [],
    state: "pending",
    usage: zeroUsage(),
  });
}

function ensureStep(job: JobRecord, stepId: string, taskId?: string): StepProjection {
  const step = (job.steps[stepId] ??= {
    id: stepId,
    status: "running",
    attempt: 0,
    usage: zeroUsage(),
  });
  if (taskId !== undefined && step.taskId === undefined) step.taskId = taskId;
  return step;
}

function applyEvent(job: JobRecord, e: AppendedEvent): void {
  const p = obj(e.payload);
  switch (e.type) {
    case EVENT_TYPES.jobCreated: {
      const t = str(p.type);
      if (t !== undefined && JOB_TYPES.includes(t)) job.type = t as JobType;
      const goal = str(p.goal);
      if (goal !== undefined) job.goal = goal;
      const branch = str(p.branch);
      if (branch !== undefined) job.branch = branch;
      job.createdAtMs = e.createdAtMs;
      break;
    }
    case EVENT_TYPES.jobStateChanged: {
      const to = str(p.to);
      if (to !== undefined && (JOB_STATES as readonly string[]).includes(to)) {
        job.state = to as JobState;
        const reason = str(p.reason);
        if (reason !== undefined) job.stateReason = reason;
        else delete job.stateReason;
      }
      break;
    }
    case EVENT_TYPES.taskCreated: {
      if (e.taskId === undefined) break;
      const task = ensureTask(job, e.taskId);
      const role = str(p.role);
      if (role !== undefined) task.role = role;
      if (Array.isArray(p.dependsOn)) {
        task.dependsOn = p.dependsOn.filter((d): d is string => typeof d === "string");
      }
      if (Array.isArray(p.acceptanceChecks)) task.acceptanceChecks = [...p.acceptanceChecks];
      break;
    }
    case EVENT_TYPES.taskStateChanged: {
      if (e.taskId === undefined) break;
      const task = ensureTask(job, e.taskId);
      const to = str(p.to);
      if (to !== undefined && (TASK_STATES as readonly string[]).includes(to)) {
        task.state = to as TaskState;
        const reason = str(p.reason);
        if (reason !== undefined) task.stateReason = reason;
        else delete task.stateReason;
      }
      break;
    }
    case EVENT_TYPES.stepStarted: {
      if (e.stepId === undefined) break;
      const step = ensureStep(job, e.stepId, e.taskId);
      step.status = "running";
      step.attempt += 1;
      delete step.failureReason;
      const model = str(p.model);
      if (model !== undefined) step.model = model;
      const agentId = str(p.agentId);
      if (agentId !== undefined) step.agentId = agentId;
      if (typeof p.leaseExpiresAtMs === "number") step.lease = { expiresAtMs: p.leaseExpiresAtMs };
      break;
    }
    case EVENT_TYPES.leaseHeartbeat: {
      if (e.stepId === undefined) break;
      const step = job.steps[e.stepId];
      // A heartbeat only extends a lease that is still held by a running step.
      if (step?.status === "running" && typeof p.expiresAtMs === "number") {
        step.lease = { expiresAtMs: p.expiresAtMs };
      }
      break;
    }
    case EVENT_TYPES.leaseReclaimed: {
      if (e.stepId === undefined) break;
      const step = ensureStep(job, e.stepId, e.taskId);
      step.status = "reclaimed";
      delete step.lease;
      break;
    }
    case EVENT_TYPES.stepCompleted: {
      if (e.stepId === undefined) break;
      const step = ensureStep(job, e.stepId, e.taskId);
      step.status = "completed";
      delete step.lease;
      accountStep(job, step, e, p);
      break;
    }
    case EVENT_TYPES.stepFailed: {
      if (e.stepId === undefined) break;
      const step = ensureStep(job, e.stepId, e.taskId);
      step.status = "failed";
      delete step.lease;
      const reason = str(p.reason);
      if (reason !== undefined) step.failureReason = reason;
      accountStep(job, step, e, p);
      break;
    }
    default:
      break;
  }
}

/**
 * Pure fold of events into Job, Task and Step state (Req 5.3). Events are applied in
 * ascending id order regardless of input order, and the input is never mutated, so
 * folding the same events twice gives deeply equal results (Req 5.10). The fold trusts
 * the log: it applies recorded state changes without re-checking transition rules,
 * because the engine validates transitions before it appends.
 */
export function projectJobState(events: readonly AppendedEvent[]): JobProjection {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const jobs: Record<string, JobRecord> = {};
  let lastEventId = 0;
  for (const e of ordered) {
    const job = (jobs[e.jobId] ??= emptyJob(e.jobId, e.createdAtMs));
    applyEvent(job, e);
    job.updatedAtMs = e.createdAtMs;
    job.timeline.push({
      eventId: e.id,
      atMs: e.createdAtMs,
      type: e.type,
      ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
      ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
    });
    lastEventId = e.id;
  }
  return { jobs, lastEventId };
}
