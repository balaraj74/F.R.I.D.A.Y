// Step_Runner (Requirement 6): runs one Step as a fresh-context agent turn with budgets,
// a stall Watchdog, retries, model fallback and a Lease. Everything external is injected:
// the agent turn, the Event_Log writer, the clock/timers, sleep and the file system.
import { grantLease, heartbeat, type Lease } from "../engine/lease.js";
import type { AppendedEvent, NewEvent } from "../store/types.js";
import { EVENT_TYPES } from "../store/project.js";
import {
  nodeRunnerFs,
  sleepWithClock,
  systemClock,
  type RunnerClock,
  type RunnerFs,
  type Sleep,
} from "./deps.js";
import { RUNNER_EVENT_TYPES } from "./events.js";
import {
  buildStepInput,
  checkBudget,
  EXHAUSTED,
  isEmptyReply,
  nextBackoffMs,
  pickFallbackModel,
  validateTimeoutSeconds,
  type Budget,
  type BudgetDimension,
  type BudgetUsage,
  type StepInput,
  type TaskResult,
} from "./helpers.js";
import { renderProgress } from "./progress.js";
import { resolveStallTimeoutSeconds, startWatchdog } from "./watchdog.js";

/** Attempts allowed per Step before it is failed (Requirement 6.8, 6.10). */
export const MAX_STEP_ATTEMPTS = 5;
/** How often the Lease is renewed. Well inside the 30s Lease so one missed beat is survivable. */
export const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;
/** progress.md must be written inside this window so the result lands within 5s (Req 6.2). */
export const PROGRESS_WRITE_DEADLINE_MS = 3_000;

/** Throw this from the turn runner when the Proxy cannot be reached (Requirement 6.8). */
export class ProxyUnreachableError extends Error {
  constructor(message = "Proxy unreachable") {
    super(message);
    this.name = "ProxyUnreachableError";
  }
}

export type TurnUsage = { inputTokens: number; outputTokens: number; toolCalls: number };

export type AgentTurnRequest = {
  jobId: string;
  taskId?: string;
  stepId: string;
  model: string;
  /** Progress_File text and upstream results only. No earlier Step transcript (Req 6.1). */
  input: StepInput;
  /** Aborted when the runner cancels the attempt. The turn should stop promptly. */
  signal: AbortSignal;
  /**
   * Call on every piece of output (token delta, tool call, tool result). This resets the stall
   * timer. Pass cumulative totals for this attempt so budgets are checked as work happens.
   */
  reportActivity: (usage?: Partial<TurnUsage>) => void;
};

export type AgentTurnResult = {
  reply: string;
  /** Final cumulative usage for this attempt. */
  usage?: Partial<TurnUsage>;
  /** Short summary for progress.md. Defaults to the start of the reply. */
  progressNote?: string;
};

export type AgentTurnRunner = (req: AgentTurnRequest) => Promise<AgentTurnResult>;

export type StepRunnerDeps = {
  runTurn: AgentTurnRunner;
  /** Writes to the Event_Log, e.g. `(e) => appendEvent(db, e)`. May throw; see `runStep`. */
  appendEvent: (event: NewEvent) => AppendedEvent | void | Promise<AppendedEvent | void>;
  clock?: RunnerClock;
  sleep?: Sleep;
  fs?: RunnerFs;
};

export type StepRunRequest = {
  jobId: string;
  taskId?: string;
  stepId: string;
  progressPath: string;
  upstream: TaskResult[];
  /** Fallback list in preference order (e.g. from `orderFallbackList`). */
  models: readonly string[];
  stepBudget: Budget;
  jobBudget: Budget;
  /** Usage by earlier Steps of the same Job. Defaults to zero. */
  jobUsageBefore?: BudgetUsage;
  /** Raw user value. Validated here; invalid or missing uses 600s and appends an event. */
  timeoutSeconds?: unknown;
  /** Seconds without output before the Watchdog cancels. Default 120. */
  stallTimeoutSeconds?: unknown;
  /**
   * Aborts the Step on behalf of the caller (Job cancel, denied approval). The running attempt is
   * abandoned, the Lease is released by a `step-failed` event with cause "cancelled", and the
   * result is `{ status: "cancelled" }`. Already aborted before the first attempt: nothing runs.
   */
  cancelSignal?: AbortSignal;
  /**
   * Caps the attempts for this run, 1 to `MAX_STEP_ATTEMPTS`. The Orchestrator passes 1 for the
   * single retry after a Proxy restart (Req 13.11). Invalid or absent means the default cap.
   */
  maxAttempts?: number;
};

export type StepFailureKind =
  | "budget-exceeded"
  | "proxy-unreachable"
  | "all-models-failed"
  | "retry-limit";

export type StepRunResult =
  | { status: "completed"; model: string; reply: string; attempts: number; usage: BudgetUsage }
  | {
      status: "failed";
      failure: StepFailureKind;
      reason: string;
      attempts: number;
      usage: BudgetUsage;
    }
  /** The Lease expired mid-run. No terminal event is written; boot restore reclaims the Step. */
  | { status: "lease-lost"; attempts: number; usage: BudgetUsage }
  /** Stopped through `cancelSignal`. Any started Step has been failed, so its Lease is released. */
  | { status: "cancelled"; attempts: number; usage: BudgetUsage };

type BudgetHit = {
  scope: "step" | "job";
  dimension: BudgetDimension;
  usage: BudgetUsage;
  limit: number;
};

type Failure =
  | { kind: "empty" }
  | { kind: "stall"; idleMs: number }
  | { kind: "timeout"; timeoutSeconds: number }
  | { kind: "proxy-unreachable"; message: string }
  | { kind: "error"; message: string };

type AttemptOutcome =
  | { kind: "ok"; reply: string; progressNote?: string }
  | Failure
  | { kind: "budget"; hit: BudgetHit }
  | { kind: "lease-lost" }
  | { kind: "cancelled" }
  | { kind: "fatal"; error: unknown };

const ZERO_USAGE: BudgetUsage = { tokens: 0, wallClockMs: 0, toolCalls: 0 };

function addUsage(a: BudgetUsage, b: BudgetUsage): BudgetUsage {
  return {
    tokens: a.tokens + b.tokens,
    wallClockMs: a.wallClockMs + b.wallClockMs,
    toolCalls: a.toolCalls + b.toolCalls,
  };
}

function describeInvalidTimeout(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

function describeFailure(f: Failure): string {
  switch (f.kind) {
    case "empty":
      return "model returned an empty reply";
    case "stall":
      return `no output for ${Math.round(f.idleMs / 1000)}s`;
    case "timeout":
      return `step timeout of ${f.timeoutSeconds}s reached`;
    case "proxy-unreachable":
      return `Proxy unreachable: ${f.message}`;
    case "error":
      return f.message;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one Step to a terminal result. Appends `step-started` per attempt, then exactly one of
 * `step-completed` or `step-failed` (except `lease-lost`, see `StepRunResult`).
 *
 * Failure handling per attempt:
 * - empty reply, stall, timeout or error: the model is marked tried and the next model in the
 *   fallback list is used; when the list is exhausted the Step fails with "all models failed".
 * - Proxy unreachable: the same model is retried, since the model itself did not fail.
 * - Every retry waits `nextBackoffMs(failedAttempts)`. After `MAX_STEP_ATTEMPTS` the Step fails
 *   with a reason naming the last cause.
 * - Budget exceeded is terminal and never retried.
 *
 * Token and tool-call usage accumulates across attempts for the Step Budget. Wall-clock counts
 * time spent in attempts, not backoff sleeps. A throw from `appendEvent` or from the file
 * system's `readText` rejects the returned promise, with no retry (Req 5.2).
 */
export async function runStep(deps: StepRunnerDeps, req: StepRunRequest): Promise<StepRunResult> {
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? sleepWithClock(clock);
  const fs = deps.fs ?? nodeRunnerFs;
  const jobUsageBefore = req.jobUsageBefore ?? ZERO_USAGE;
  const stallTimeoutSeconds = resolveStallTimeoutSeconds(req.stallTimeoutSeconds);
  const maxAttempts =
    typeof req.maxAttempts === "number" &&
    Number.isInteger(req.maxAttempts) &&
    req.maxAttempts >= 1 &&
    req.maxAttempts <= MAX_STEP_ATTEMPTS
      ? req.maxAttempts
      : MAX_STEP_ATTEMPTS;

  const emit = async (type: string, payload: unknown): Promise<void> => {
    await deps.appendEvent({
      jobId: req.jobId,
      ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
      stepId: req.stepId,
      type,
      payload,
      createdAtMs: clock.now(),
    });
  };

  // Req 6.12: reject a bad timeout, use the default, and say which value was rejected.
  const timeout = validateTimeoutSeconds(req.timeoutSeconds);
  if (timeout.usedDefault) {
    await emit(RUNNER_EVENT_TYPES.invalidTimeout, {
      value: describeInvalidTimeout(req.timeoutSeconds),
      defaultSeconds: timeout.value,
    });
  }

  // Req 6.1: the only inputs are progress.md and upstream results.
  const input = buildStepInput((await fs.readText(req.progressPath)) ?? "", req.upstream);

  // Usage from finished attempts. The current attempt adds to it while it runs.
  let used: BudgetUsage = ZERO_USAGE;
  // Same tokens split by direction, recorded on the completion event for per-Step accounting.
  let usedIO = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  const tried: string[] = [];

  // Run-level interrupts: the Lease expired, or a timer-driven Event_Log write failed.
  let lease: Lease = grantLease(clock.now(), req.stepId);
  let resolveLost!: (o: { kind: "lease-lost" } | { kind: "fatal"; error: unknown }) => void;
  const lost = new Promise<{ kind: "lease-lost" } | { kind: "fatal"; error: unknown }>(
    (resolve) => (resolveLost = resolve),
  );
  let cancelHeartbeat: (() => void) | undefined;
  let heartbeatOn = true;
  const beat = () => {
    if (!heartbeatOn) return;
    const renewed = heartbeat(lease, clock.now());
    if (!renewed.ok) {
      resolveLost({ kind: "lease-lost" });
      return;
    }
    lease = renewed.value;
    Promise.resolve(emit(EVENT_TYPES.leaseHeartbeat, { expiresAtMs: lease.expiresAtMs })).then(
      () => {
        if (heartbeatOn) cancelHeartbeat = clock.setTimer(beat, LEASE_HEARTBEAT_INTERVAL_MS);
      },
      (error: unknown) => resolveLost({ kind: "fatal", error }),
    );
  };
  const stopHeartbeat = () => {
    heartbeatOn = false;
    cancelHeartbeat?.();
  };
  cancelHeartbeat = clock.setTimer(beat, LEASE_HEARTBEAT_INTERVAL_MS);

  const evaluateBudgets = (stepUsage: BudgetUsage): BudgetHit | null => {
    const step = checkBudget(stepUsage, req.stepBudget).exceeded;
    if (step) {
      return { scope: "step", dimension: step, usage: stepUsage, limit: req.stepBudget[step] };
    }
    const jobUsage = addUsage(jobUsageBefore, stepUsage);
    const job = checkBudget(jobUsage, req.jobBudget).exceeded;
    if (job) return { scope: "job", dimension: job, usage: jobUsage, limit: req.jobBudget[job] };
    return null;
  };

  const runAttempt = async (attempt: number, model: string): Promise<AttemptOutcome> => {
    const startedAtMs = clock.now();
    await emit(EVENT_TYPES.stepStarted, {
      model,
      attempt,
      leaseExpiresAtMs: lease.expiresAtMs,
    });

    const controller = new AbortController();
    const cancels: Array<() => void> = [];
    let finished = false;
    const counters: TurnUsage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
    let resolveInterrupt!: (o: AttemptOutcome) => void;
    const interrupted = new Promise<AttemptOutcome>((resolve) => (resolveInterrupt = resolve));

    const attemptUsage = (): BudgetUsage => ({
      tokens: counters.inputTokens + counters.outputTokens,
      toolCalls: counters.toolCalls,
      wallClockMs: clock.now() - startedAtMs,
    });
    const checkBudgets = () => {
      if (finished) return;
      const hit = evaluateBudgets(addUsage(used, attemptUsage()));
      if (hit) resolveInterrupt({ kind: "budget", hit });
    };
    const applyUsage = (u?: Partial<TurnUsage>) => {
      if (!u) return;
      for (const key of ["inputTokens", "outputTokens", "toolCalls"] as const) {
        const v = u[key];
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) counters[key] = v;
      }
    };

    const onCancel = () => resolveInterrupt({ kind: "cancelled" });
    if (req.cancelSignal?.aborted) onCancel();
    req.cancelSignal?.addEventListener("abort", onCancel, { once: true });
    cancels.push(() => req.cancelSignal?.removeEventListener("abort", onCancel));

    const watchdog = startWatchdog({
      clock,
      stallTimeoutMs: stallTimeoutSeconds * 1000,
      onStall: (idleMs) => resolveInterrupt({ kind: "stall", idleMs }),
    });
    cancels.push(() => watchdog.stop());
    cancels.push(
      clock.setTimer(
        () => resolveInterrupt({ kind: "timeout", timeoutSeconds: timeout.value }),
        timeout.value * 1000,
      ),
    );

    // Wall-clock Budget has no natural event, so poll at the earliest possible deadline.
    const armWallClock = () => {
      const now = addUsage(used, attemptUsage());
      const remaining = Math.min(
        req.stepBudget.wallClockMs - now.wallClockMs,
        req.jobBudget.wallClockMs - (jobUsageBefore.wallClockMs + now.wallClockMs),
      );
      if (!Number.isFinite(remaining)) return;
      // +1 ms because the limit is exceeded only when usage is strictly greater.
      cancels.push(
        clock.setTimer(
          () => {
            checkBudgets();
            if (!finished) armWallClock();
          },
          Math.max(remaining, 0) + 1,
        ),
      );
    };
    armWallClock();

    const turn: Promise<AttemptOutcome> = deps
      .runTurn({
        jobId: req.jobId,
        ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
        stepId: req.stepId,
        model,
        input,
        signal: controller.signal,
        reportActivity: (usage) => {
          if (finished) return;
          watchdog.touch();
          applyUsage(usage);
          checkBudgets();
        },
      })
      .then(
        (result): AttemptOutcome => {
          applyUsage(result.usage);
          const hit = evaluateBudgets(addUsage(used, attemptUsage()));
          if (hit) return { kind: "budget", hit };
          if (isEmptyReply(result.reply)) return { kind: "empty" };
          return {
            kind: "ok",
            reply: result.reply,
            ...(result.progressNote !== undefined ? { progressNote: result.progressNote } : {}),
          };
        },
        (error: unknown): AttemptOutcome =>
          error instanceof ProxyUnreachableError
            ? { kind: "proxy-unreachable", message: error.message }
            : { kind: "error", message: errorMessage(error) },
      );

    try {
      // Whichever settles first wins. An abandoned turn is told to abort in `finally`; its late
      // result is dropped, so cancelling never waits on the turn (stop within 5s, Req 6.4, 6.6).
      return await Promise.race([turn, interrupted, lost]);
    } finally {
      finished = true;
      for (const cancel of cancels) cancel();
      used = addUsage(used, attemptUsage());
      usedIO = {
        inputTokens: usedIO.inputTokens + counters.inputTokens,
        outputTokens: usedIO.outputTokens + counters.outputTokens,
      };
      controller.abort();
    }
  };

  const fail = async (
    failure: StepFailureKind,
    reason: string,
    extra?: { event: string; payload: unknown },
  ): Promise<StepRunResult> => {
    stopHeartbeat();
    if (extra) await emit(extra.event, extra.payload);
    await emit(EVENT_TYPES.stepFailed, { reason, cause: failure, attempts });
    return { status: "failed", failure, reason, attempts, usage: used };
  };

  const failBudget = (hit: BudgetHit): Promise<StepRunResult> => {
    const label = hit.scope === "step" ? "per-Step" : "per-Job";
    return fail("budget-exceeded", `budget exceeded: ${hit.dimension} (${label})`, {
      event: RUNNER_EVENT_TYPES.budgetExceeded,
      payload: {
        exceeded: hit.dimension,
        scope: hit.scope,
        usage: hit.usage,
        limit: hit.limit,
      },
    });
  };

  /** Fails the started Step so its Lease is released, then reports the cancellation. */
  const cancelled = async (): Promise<StepRunResult> => {
    stopHeartbeat();
    if (attempts > 0) {
      await emit(EVENT_TYPES.stepFailed, { reason: "cancelled", cause: "cancelled", attempts });
    }
    return { status: "cancelled", attempts, usage: used };
  };

  try {
    let lastCause = "";
    for (;;) {
      if (req.cancelSignal?.aborted) return await cancelled();
      const model = pickFallbackModel(tried, req.models);
      if (model === EXHAUSTED) {
        return await fail(
          "all-models-failed",
          lastCause ? `all models failed; last failure: ${lastCause}` : "all models failed",
        );
      }
      // A Job Budget used up by earlier Steps stops this Step before it starts.
      const early = evaluateBudgets(used);
      if (early) return await failBudget(early);

      attempts += 1;
      const attempt = attempts;
      const outcome = await runAttempt(attempt, model);

      if (outcome.kind === "ok") {
        const completedAtMs = clock.now();
        stopHeartbeat();
        await recordCompletion(outcome.reply, outcome.progressNote, completedAtMs, model, attempt);
        return { status: "completed", model, reply: outcome.reply, attempts, usage: used };
      }
      if (outcome.kind === "budget") return await failBudget(outcome.hit);
      if (outcome.kind === "fatal") throw outcome.error;
      if (outcome.kind === "cancelled") return await cancelled();
      if (outcome.kind === "lease-lost") {
        stopHeartbeat();
        await emit(RUNNER_EVENT_TYPES.leaseLost, { attempt, model });
        return { status: "lease-lost", attempts, usage: used };
      }

      // Failure of one attempt.
      lastCause = describeFailure(outcome);
      if (outcome.kind === "stall") {
        await emit(RUNNER_EVENT_TYPES.stall, {
          attempt,
          model,
          stallTimeoutSeconds,
          idleMs: outcome.idleMs,
        });
      } else {
        await emit(RUNNER_EVENT_TYPES.attemptFailed, {
          attempt,
          model,
          cause: outcome.kind,
          message: lastCause,
        });
      }

      if (outcome.kind === "proxy-unreachable") {
        if (attempt >= maxAttempts) {
          return await fail(
            "proxy-unreachable",
            `Proxy unreachable after ${attempt} attempts: ${outcome.message}`,
          );
        }
      } else {
        tried.push(model);
        if (pickFallbackModel(tried, req.models) === EXHAUSTED) {
          return await fail("all-models-failed", `all models failed; last failure: ${lastCause}`);
        }
        if (attempt >= maxAttempts) {
          return await fail(
            "retry-limit",
            `retry limit of ${maxAttempts} attempts reached; last failure: ${lastCause}`,
          );
        }
      }

      const delayMs = nextBackoffMs(attempt);
      const nextModel = pickFallbackModel(tried, req.models);
      await emit(RUNNER_EVENT_TYPES.stepRetry, {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        nextModel,
        cause: outcome.kind,
      });
      const cancelledDuringBackoff = new Promise<{ kind: "cancelled" }>((resolve) => {
        if (req.cancelSignal?.aborted) resolve({ kind: "cancelled" });
        req.cancelSignal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
          once: true,
        });
      });
      const interrupt = await Promise.race([
        sleep(delayMs).then(() => null),
        lost,
        cancelledDuringBackoff,
      ]);
      if (interrupt?.kind === "cancelled") return await cancelled();
      if (interrupt?.kind === "fatal") throw interrupt.error;
      if (interrupt?.kind === "lease-lost") {
        stopHeartbeat();
        await emit(RUNNER_EVENT_TYPES.leaseLost, { attempt, model });
        return { status: "lease-lost", attempts, usage: used };
      }
    }
  } finally {
    stopHeartbeat();
  }

  /** Updates progress.md, then appends the result, so both land within 5s of completion (Req 6.2). */
  async function recordCompletion(
    reply: string,
    note: string | undefined,
    completedAtMs: number,
    model: string,
    attempt: number,
  ): Promise<void> {
    try {
      const previous = (await fs.readText(req.progressPath)) ?? "";
      const next = renderProgress(previous, {
        stepId: req.stepId,
        ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
        atMs: completedAtMs,
        note: note ?? reply,
      });
      await withDeadline(
        clock,
        fs.writeText(req.progressPath, next),
        PROGRESS_WRITE_DEADLINE_MS,
        `writing ${req.progressPath} took longer than ${PROGRESS_WRITE_DEADLINE_MS}ms`,
      );
    } catch (error) {
      // The result is still recorded in the Event_Log; resume reads progress from there if needed.
      await emit(RUNNER_EVENT_TYPES.progressWriteFailed, {
        path: req.progressPath,
        message: errorMessage(error),
      });
    }
    await emit(EVENT_TYPES.stepCompleted, {
      model,
      attempt,
      result: reply,
      usage: { ...used, ...usedIO },
      elapsedMs: used.wallClockMs,
    });
  }
}

/** Rejects if `work` has not settled after `ms`. The late result of `work` is ignored. */
function withDeadline<T>(
  clock: RunnerClock,
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = clock.setTimer(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        cancel();
        resolve(v);
      },
      (e: unknown) => {
        cancel();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
