// Rebuilds what the Orchestrator needs to continue a Job after a Gateway restart (Req 13.10).
// Pure: reads the Event_Log and returns the saved plan, which Steps finished, and where each
// unfinished Task stands. `adoptJob` in runtime.ts turns this into a running Job.
import type { BudgetUsage } from "../runner/helpers.js";
import { EVENT_TYPES, projectJobState } from "../store/project.js";
import type { AppendedEvent, JobState, TaskState } from "../store/types.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import {
  DEFAULT_TASK_REPLY_ESTIMATE_TOKENS,
  sizeTaskSteps,
  type PlannedTask,
} from "./plan-parse.js";
import { ROLES, type AcceptanceCheck, type Role } from "./types.js";

/** Where an unfinished Task restarts: verification round (Step ids carry it) and attempts used. */
export type TaskResume = { round: number; attempt: number };

export type Adoption = {
  jobId: string;
  goal: string;
  state: JobState;
  concurrencyLimit?: number;
  /** Saved plan; null when planning had not finished, so the Planner has to run again. */
  tasks: PlannedTask[] | null;
  /** True when the plan was accepted but its Tasks were only partly saved. Not recoverable. */
  planIncomplete: boolean;
  taskStates: Record<string, TaskState>;
  /** Tasks skipped because Sir denied an action; their dependents count them as satisfied. */
  deniedSkipped: string[];
  /** Reply of every completed Step, by Step id. These Steps are never run again. */
  completedSteps: Map<string, string>;
  /** Reply of each Task's last completed Step, handed on to dependent Tasks. */
  results: Map<string, string>;
  usage: BudgetUsage;
  resume: Map<string, TaskResume>;
  /** Steps still marked running: the process that ran them is gone. */
  orphanedSteps: Array<{ stepId: string; taskId?: string }>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** The Task as saved in its `task-created` event, or undefined when the payload is unusable. */
function readTask(e: AppendedEvent): PlannedTask | undefined {
  if (e.taskId === undefined || !isRecord(e.payload)) return undefined;
  const p = e.payload;
  if (!ROLES.some((r) => r === p.role)) return undefined;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
  const steps =
    Array.isArray(p.steps) && p.steps.length > 0
      ? p.steps.flatMap((s) =>
          isRecord(s) && typeof s.index === "number" && typeof s.expectedReplyTokens === "number"
            ? [{ index: s.index, expectedReplyTokens: s.expectedReplyTokens }]
            : [],
        )
      : sizeTaskSteps(DEFAULT_TASK_REPLY_ESTIMATE_TOKENS);
  return {
    id: e.taskId,
    role: p.role as Role,
    dependsOn: strings(p.dependsOn),
    acceptanceChecks: Array.isArray(p.acceptanceChecks)
      ? (p.acceptanceChecks as AcceptanceCheck[])
      : [],
    ...(Array.isArray(p.requiresOutputFrom)
      ? { requiresOutputFrom: strings(p.requiresOutputFrom) }
      : {}),
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    ...(typeof p.instructions === "string" ? { instructions: p.instructions } : {}),
    steps,
  };
}

/** Reads one Job's events. Returns undefined when the log has nothing for the Job. */
export function buildAdoption(
  events: readonly AppendedEvent[],
  jobId: string,
): Adoption | undefined {
  const mine = events.filter((e) => e.jobId === jobId).sort((a, b) => a.id - b.id);
  const job = projectJobState(mine).jobs[jobId];
  if (!job || !mine.some((e) => e.type === EVENT_TYPES.jobCreated)) return undefined;

  const created = mine.find((e) => e.type === EVENT_TYPES.jobCreated);
  const createdPayload = isRecord(created?.payload) ? created.payload : {};

  const tasks: PlannedTask[] = [];
  const completedSteps = new Map<string, string>();
  const lastReplyByTask = new Map<string, string>();
  const usage: BudgetUsage = { tokens: 0, wallClockMs: 0, toolCalls: 0 };
  const verifications = new Map<string, { total: number; retries: number }>();
  let acceptedCount: number | undefined;

  for (const e of mine) {
    const p = isRecord(e.payload) ? e.payload : {};
    if (e.type === EVENT_TYPES.taskCreated) {
      const task = readTask(e);
      if (task && !tasks.some((t) => t.id === task.id)) tasks.push(task);
    } else if (e.type === ORCHESTRATOR_EVENT_TYPES.planAccepted) {
      acceptedCount = typeof p.taskCount === "number" ? p.taskCount : undefined;
    } else if (e.type === EVENT_TYPES.stepCompleted && e.stepId !== undefined) {
      const reply = typeof p.result === "string" ? p.result : "";
      completedSteps.set(e.stepId, reply);
      if (e.taskId !== undefined) lastReplyByTask.set(e.taskId, reply);
      const u = isRecord(p.usage) ? p.usage : {};
      usage.tokens += finiteNumber(u.tokens);
      usage.wallClockMs += finiteNumber(u.wallClockMs);
      usage.toolCalls += finiteNumber(u.toolCalls);
    } else if (e.type === ORCHESTRATOR_EVENT_TYPES.verificationResult && e.taskId !== undefined) {
      const v = verifications.get(e.taskId) ?? { total: 0, retries: 0 };
      v.total += 1;
      if (p.outcome === "retry") v.retries += 1;
      verifications.set(e.taskId, v);
    }
  }

  const taskStates: Record<string, TaskState> = {};
  const deniedSkipped: string[] = [];
  const results = new Map<string, string>();
  const resume = new Map<string, TaskResume>();
  for (const t of tasks) {
    const projected = job.tasks[t.id];
    taskStates[t.id] = projected?.state ?? "pending";
    if (
      projected?.state === "skipped" &&
      projected.stateReason?.startsWith("approval denied") === true
    ) {
      deniedSkipped.push(t.id);
    }
    const reply = lastReplyByTask.get(t.id);
    if (reply !== undefined) results.set(t.id, reply);
    const v = verifications.get(t.id);
    resume.set(t.id, { round: (v?.retries ?? 0) + 1, attempt: v?.total ?? 0 });
  }

  return {
    jobId,
    goal: job.goal ?? "",
    state: job.state,
    ...(typeof createdPayload.concurrencyLimit === "number"
      ? { concurrencyLimit: createdPayload.concurrencyLimit }
      : {}),
    tasks:
      tasks.length > 0 && (acceptedCount === undefined || tasks.length >= acceptedCount)
        ? tasks
        : null,
    planIncomplete: acceptedCount !== undefined && tasks.length > 0 && tasks.length < acceptedCount,
    taskStates,
    deniedSkipped,
    completedSteps,
    results,
    usage,
    resume,
    orphanedSteps: Object.values(job.steps)
      .filter((s) => s.status === "running")
      .map((s) => ({ stepId: s.id, ...(s.taskId !== undefined ? { taskId: s.taskId } : {}) })),
  };
}
