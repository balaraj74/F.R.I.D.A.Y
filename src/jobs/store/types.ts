// Shared types for the Event_Log store (Requirement 5).
// The `events` table is the only persisted engine state; every other shape here is a projection.

export type JobType = "coding" | "research" | "operations";

export const JOB_STATES = [
  "pending",
  "running",
  "waiting_approval",
  "verifying",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TASK_STATES = [
  "pending",
  "running",
  "waiting_approval",
  "verifying",
  "done",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type StepStatus = "running" | "completed" | "failed" | "reclaimed";

/** An event as supplied by a caller, before the store assigns `id`. */
export type NewEvent = {
  jobId: string;
  taskId?: string;
  stepId?: string;
  type: string;
  /** Any JSON-serializable value. */
  payload?: unknown;
  /** Defaults to `Date.now()`. Callers with a fake clock pass it explicitly. */
  createdAtMs?: number;
};

/** An event as stored: `id` is the monotonic replay order. */
export type AppendedEvent = {
  id: number;
  jobId: string;
  taskId?: string;
  stepId?: string;
  type: string;
  payload: unknown;
  createdAtMs: number;
};

export type LoadWarning = {
  /** Row id of the discarded event, when it could be read. */
  eventId: number | null;
  /** `final` is the truncated trailing row (Req 5.12); `interior` is a corrupt row before the end. */
  position: "final" | "interior";
  reason: string;
};

export type LoadResult = { events: AppendedEvent[]; warnings: LoadWarning[] };

export type TimelineEntry = {
  eventId: number;
  atMs: number;
  type: string;
  taskId?: string;
  stepId?: string;
};

export type LeaseView = { expiresAtMs: number };

/**
 * Token and time accounting (Req 10.7). Every figure is the sum of the numbers carried by
 * step-completed / step-failed events, so Task and Job totals come from the same events.
 */
export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
  elapsedMs: number;
};

export type StepProjection = {
  id: string;
  taskId?: string;
  /** Agent that ran the step, from the step-started or step-completed/failed payload. */
  agentId?: string;
  status: StepStatus;
  model?: string;
  /** Present only while the step is running. */
  lease?: LeaseView;
  attempt: number;
  failureReason?: string;
  /** Sum over every completed or failed attempt of this step. */
  usage: UsageTotals;
};

export type TaskProjection = {
  id: string;
  jobId: string;
  role?: string;
  dependsOn: string[];
  acceptanceChecks: unknown[];
  state: TaskState;
  stateReason?: string;
  /** Sum of the accounting of every step event attributed to this task. */
  usage: UsageTotals;
};

export type JobRecord = {
  id: string;
  type?: JobType;
  goal?: string;
  branch?: string;
  state: JobState;
  stateReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
  tasks: Record<string, TaskProjection>;
  steps: Record<string, StepProjection>;
  /**
   * Job token total (Req 10.8). Counts exactly the step events attributed to a Task, so
   * it equals the sum of `tasks[*].usage` by construction.
   */
  usage: UsageTotals;
  /** Per-agent totals over the same attributed step events (sums to `usage`). */
  agentUsage: Record<string, UsageTotals>;
  /** Step events with no resolvable Task. Kept out of `usage` so the Req 10.8 invariant holds. */
  unattributedUsage: UsageTotals;
  timeline: TimelineEntry[];
};

export type JobProjection = {
  jobs: Record<string, JobRecord>;
  /** Id of the last event folded, or 0 for an empty log. */
  lastEventId: number;
};
