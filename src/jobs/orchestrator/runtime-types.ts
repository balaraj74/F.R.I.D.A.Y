// Injectable boundaries and public shapes of the Orchestrator runtime (Requirement 7).
// Agent execution, the clock, the event database and evidence collection are all supplied by
// the caller, so tests run with fakes and no model calls.
import type { DatabaseSync } from "node:sqlite";

import type { Notifier } from "../ops/notifier.js";
import type { RunnerClock, RunnerFs, Sleep } from "../runner/deps.js";
import type { Budget } from "../runner/helpers.js";
import type { AgentTurnRequest, AgentTurnResult } from "../runner/step-runner.js";
import type { JobState, JobType, TaskState, UsageTotals } from "../store/types.js";
import type { LoopControlDeps } from "./loop-control.js";
import type { PlannedStep } from "./plan-parse.js";
import type { AcceptanceCheck, Evidence, Role } from "./types.js";

// ---------------------------------------------------------------------------------------
// Tool gate (Requirement 7.5)
// ---------------------------------------------------------------------------------------

export type ToolCallResult = { ok: true; value: unknown } | { ok: false; error: string };
export type ToolDecision = { allowed: true } | { allowed: false; error: string };

/** The action an agent wants to take, as seen by the pre-action hook. */
export type PreActionRequest = {
  jobId: string;
  taskId: string;
  stepId?: string;
  role: Role;
  tool: string;
  args?: unknown;
};

/**
 * Extension point that runs after the Role allowlist check and before the tool executes.
 * Approvals (Requirement 8), worktree confinement (Requirement 9) and loop control
 * (Requirement 10) plug in here. A refusal is recorded and returned to the agent as an error.
 */
export type PreActionHook = (
  action: PreActionRequest,
) =>
  | { allow: true }
  | { allow: false; reason: string }
  | Promise<{ allow: true } | { allow: false; reason: string }>;

/** Executes a tool the gate has already approved. Absent in tests that only check gating. */
export type ToolInvoker = (action: PreActionRequest) => Promise<unknown>;

/** Handed to every agent turn. All tool use goes through it so the Role allowlist holds. */
export interface ToolGate {
  /** Checks the allowlist, then the pre-action hook. Records a denial before returning it. */
  authorize(tool: string, args?: unknown): Promise<ToolDecision>;
  /** `authorize`, then run the tool. A denial comes back as `{ ok: false, error }`. */
  call(tool: string, args?: unknown): Promise<ToolCallResult>;
}

// ---------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------

export type AgentPurpose = "task" | "verifier";

export type AgentSpec = {
  jobId: string;
  taskId: string;
  role: Role;
  purpose: AgentPurpose;
  /** Session key allocated by the Orchestrator. The factory must run the agent under it. */
  sessionKey: string;
};

/** One Step turn as the executing agent sees it. Extends the Step_Runner request. */
export type OrchestratedTurnRequest = AgentTurnRequest & {
  agentId: string;
  sessionKey: string;
  role: Role;
  task: {
    id: string;
    title?: string;
    instructions?: string;
    acceptanceChecks: AcceptanceCheck[];
  };
  step: PlannedStep & { count: number };
  /** 1 for the first run of the Task, +1 each time verification sent it back to running. */
  round: number;
  gate: ToolGate;
};

/** A running agent instance with its own session. */
export interface AgentInstance {
  readonly id: string;
  readonly sessionKey: string;
  runTurn(req: OrchestratedTurnRequest): Promise<AgentTurnResult>;
  dispose?(): void | Promise<void>;
}

export interface AgentFactory {
  /** Always returns a new instance. The Verifier relies on never getting a reused one. */
  create(spec: AgentSpec): AgentInstance | Promise<AgentInstance>;
}

// ---------------------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------------------

export type PlanRequest = {
  jobId: string;
  goal: string;
  /** 1 for the first plan, then 2..4 for the correction attempts. */
  attempt: number;
  /** Validation errors from the previous attempt. Empty on the first attempt. */
  previousErrors: string[];
  previousOutput?: unknown;
  /** Aborts when the 60s planning limit is reached. */
  signal: AbortSignal;
};

/** Returns raw plan output (object, array or JSON text). Validated by the Orchestrator. */
export type PlannerAgent = (req: PlanRequest) => Promise<unknown>;

// ---------------------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------------------

export type EvidenceContext = {
  jobId: string;
  taskId: string;
  check: AcceptanceCheck;
  checkIndex: number;
  /** The fresh Verifier agent, in its own session. Never the agent that ran the Task. */
  verifier: AgentInstance;
  /** Tool gate for the `verifier` Role. */
  gate: ToolGate;
  signal: AbortSignal;
};

/**
 * Produces Evidence for one Acceptance_Check, or undefined when none could be gathered.
 * It may throw; that counts as no Evidence for the check.
 */
export type EvidenceCollector = (ctx: EvidenceContext) => Promise<Evidence | undefined>;

// ---------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------

export type OrchestratorConfig = {
  /** Tasks running at the same time, integer 1 to 16 (Req 7.6). */
  concurrencyLimit: number;
  /** Planner time limit per attempt (Req 7.1). */
  planTimeoutMs: number;
  /** Per-check Evidence collection limit. */
  checkTimeoutMs: number;
  stepBudget: Budget;
  jobBudget: Budget;
  /** Model fallback list for Steps, in preference order. */
  models: string[];
  /** Directory for per-Task progress files. Defaults under the state dir. */
  progressDir?: string;
  /** `timeoutSeconds` passed to every Step. Invalid or absent means the runner default. */
  stepTimeoutSeconds?: number;
};

/** The slice of the Notifier the Orchestrator uses for approvals (Requirements 8.4, 8.9). */
export type ApprovalNotifier = Pick<Notifier, "requestApproval" | "decisionApplied">;

// ---------------------------------------------------------------------------------------
// Proxy restart recovery (Requirement 13.11)
// ---------------------------------------------------------------------------------------

export type ProxyRetryRequest = {
  jobId: string;
  taskId: string;
  stepId: string;
  /** Why the Step stopped, e.g. "Proxy unreachable after 5 attempts". */
  reason: string;
  /** Aborts when the Job is cancelled or the Task is denied; stop waiting then. */
  signal: AbortSignal;
};

export type ProxyRetryDecision =
  | { retry: true; respondedAtMs: number }
  | {
      retry: false;
      reason: string;
    };

/**
 * Plugged in by the Gateway (see `ProxyRestartCoordinator` in `src/jobs/ops/proxy-restart.ts`).
 * When a Step ends because the Proxy was unreachable, the Orchestrator asks `awaitRetry`. It
 * resolves once the Proxy responds again; the Orchestrator then retries the Step exactly once,
 * straight away, which is inside the 30s allowed by Req 13.11.
 */
export interface StepProxyRecovery {
  awaitRetry(req: ProxyRetryRequest): Promise<ProxyRetryDecision>;
  /** The Step cannot continue, so the Job is about to fail. The user must be told. */
  retryFailed(req: ProxyRetryRequest): void | Promise<void>;
}

/** Result of `adoptJob`. */
export type AdoptJobResult =
  | {
      ok: true;
      jobId: string;
      /** True when no plan had been saved yet, so the Planner runs again. */
      replanned: boolean;
      /** Tasks that run again (not yet done, failed, skipped or cancelled). */
      resumedTaskIds: string[];
      /** Steps that finished before the restart and are not run again. */
      completedStepIds: string[];
    }
  | {
      ok: false;
      error: "not-found" | "terminal" | "already-active" | "not-resumable";
      reason: string;
    };

export type OrchestratorDeps = {
  /** Event_Log database (see `openEventLog`). */
  db: DatabaseSync;
  planner: PlannerAgent;
  agents: AgentFactory;
  collectEvidence: EvidenceCollector;
  invokeTool?: ToolInvoker;
  /**
   * Runs for every allowed action that is not a Never_Auto_Action, and after an approval. The
   * Orchestrator itself puts the approval check in front of it (Requirement 8.1).
   */
  preAction?: PreActionHook;
  /** Sends approval requests (HUD and WhatsApp). Without it Tasks still wait for `decideApproval`. */
  notifier?: ApprovalNotifier;
  /** Retries a Step once after a Proxy restart (Req 13.11). Without it a Proxy failure fails the Step. */
  proxyRecovery?: StepProxyRecovery;
  /** Loop_Detector settings, fast models and the user notifier (Requirement 10). */
  loopControl?: LoopControlDeps;
  clock?: RunnerClock;
  sleep?: Sleep;
  fs?: RunnerFs;
  /** Id source for Jobs and session keys. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  config?: Partial<OrchestratorConfig>;
};

export type CreateJobInput = {
  goal: string;
  type?: JobType;
  /** Overrides the configured concurrency limit for this Job. */
  concurrencyLimit?: number;
  /**
   * Plan to use instead of asking the Planner for the first attempt, for callers (such as
   * the Swarm_Tool) that already know the Task graph. It is validated like Planner output,
   * and the Planner is asked for corrections if it fails.
   */
  initialPlan?: unknown;
};

export type TaskView = {
  id: string;
  role?: string;
  dependsOn: string[];
  state: TaskState;
  stateReason?: string;
  /** Reply of the Task's last completed Step. */
  result?: string;
  /** Verification attempts made so far. */
  verificationAttempts: number;
  usage: UsageTotals;
};

export type JobView = {
  id: string;
  goal?: string;
  type?: JobType;
  state: JobState;
  /** Set when the Job is failed or cancelled. */
  failureReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
  tasks: TaskView[];
};

/** Result of `decideApproval`. A later decision is recorded but changes nothing (Req 8.6). */
export type ApprovalDecisionResult =
  | {
      ok: true;
      applied: true;
      decision: "approve" | "deny";
      /** "resumed" on approve; "skipped" or "failed" on deny (Req 8.7, 8.8). */
      outcome: "resumed" | "skipped" | "failed";
      /** Set on deny. */
      reason?: string;
    }
  | { ok: true; applied: false; reason: string }
  | { ok: false; error: "unknown-task" | "invalid-decision" };

export type JobControlErrorCode = "not-found" | "not-allowed" | "not-active" | "write-failed";

/** Thrown by `pauseJob`, `resumeJob` and `cancelJob` when the request cannot be carried out. */
export class JobControlError extends Error {
  readonly code: JobControlErrorCode;
  /** Current state of the Job, when it exists. */
  readonly state?: JobState;
  constructor(code: JobControlErrorCode, message: string, state?: JobState) {
    super(message);
    this.name = "JobControlError";
    this.code = code;
    if (state !== undefined) this.state = state;
  }
}

export interface Orchestrator {
  /** Records the Job, then plans and runs it in the background. */
  createJob(input: CreateJobInput): Promise<{ id: string }>;
  /** Resolves when the Job is done, failed or cancelled. Aborting stops the wait only. */
  awaitTerminal(jobId: string, signal?: AbortSignal): Promise<JobView>;
  /** Current view projected from the Event_Log, or undefined for an unknown Job. */
  getJob(jobId: string): JobView | undefined;
  /**
   * Applies Sir's decision for a Task in waiting_approval, from `channel` ("hud", "whatsapp").
   * The first decision wins; later ones are recorded as ignored (Req 8.6-8.8).
   */
  decideApproval(
    jobId: string,
    taskId: string,
    decision: "approve" | "deny",
    channel: string,
  ): ApprovalDecisionResult;
  /**
   * Stops starting new Steps at once, lets running Steps finish, and sets the Job paused (Req 8.10).
   * Throws `JobControlError` when the Job is unknown, not running in this process, or not running.
   */
  pauseJob(jobId: string): void;
  /** Sets a paused Job running and starts ready Steps right away (Req 8.11). Throws like `pauseJob`. */
  resumeJob(jobId: string): void;
  /**
   * Stops running Steps, releases Leases, discards approvals and marks the Job cancelled, all
   * within 30s (Req 8.12, 8.13). Resolves once the Job is cancelled; throws `JobControlError`
   * for an unknown or already finished Job.
   */
  cancelJob(jobId: string, reason?: string): Promise<void>;
  /**
   * Takes over a Job left running by a previous Gateway process (Req 13.10). Completed Steps are
   * never run again; Leases still held by the dead process are released; every Task that had not
   * finished runs again from its first incomplete Step. Does not wait for the Job to finish; use
   * `awaitTerminal` for that. Paused and approval-blocked Jobs are refused.
   */
  adoptJob(jobId: string): Promise<AdoptJobResult>;
}
