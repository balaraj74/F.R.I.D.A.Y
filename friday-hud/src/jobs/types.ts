// Local mirror of the Event_Log projection types in `src/jobs/store/types.ts`. The HUD is
// a separate package (its tsconfig only includes `src`), so the pieces the Jobs_Views need
// are re-declared here instead of imported across packages. Keep them in sync with the
// originals.
export const JOB_STATES = [
  'pending',
  'running',
  'waiting_approval',
  'verifying',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TASK_STATES = [
  'pending',
  'running',
  'waiting_approval',
  'verifying',
  'done',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
  elapsedMs: number;
};

export type TaskView = {
  id: string;
  jobId: string;
  role?: string;
  dependsOn: string[];
  state: TaskState;
  usage: UsageTotals;
};

/** The part of `JobRecord` the pure helpers read. */
export type JobView = {
  id: string;
  state: JobState;
  tasks: Record<string, TaskView>;
};
