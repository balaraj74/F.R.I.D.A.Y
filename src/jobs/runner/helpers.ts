// Pure helpers for the Step_Runner and Watchdog.
// No I/O here: agent turns, timers and Event_Log writes live in the runner itself.

/** Base delay before the first retry (Requirement 6.6). */
export const RUNNER_BACKOFF_BASE_MS = 2_000;
/** Upper bound on any retry delay (Requirement 6.6). */
export const RUNNER_BACKOFF_CAP_MS = 60_000;
/** Step timeout used when `timeoutSeconds` is missing or invalid (Requirement 6.12). */
export const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
export const MIN_STEP_TIMEOUT_SECONDS = 1;
export const MAX_STEP_TIMEOUT_SECONDS = 86_400;

/** Result of an upstream Task, as handed to a downstream Step. */
export type TaskResult = {
  taskId: string;
  result: string;
};

/** The only data a fresh-context Step receives (Requirement 6.1). */
export type StepInput = {
  progress: string;
  upstream: TaskResult[];
};

/**
 * Build the input for a fresh-context Step from the Progress_File contents and the
 * results of its upstream Tasks. Each upstream result is copied down to `taskId` and
 * `result`, so extra fields on the caller's objects (messages, tool calls, transcripts
 * of earlier Steps) can never leak into the new Step. The input is a fresh value;
 * later changes to the arguments do not affect it.
 */
export function buildStepInput(progressFile: string, upstreamResults: TaskResult[]): StepInput {
  return {
    progress: progressFile,
    upstream: upstreamResults.map((r) => ({ taskId: r.taskId, result: r.result })),
  };
}

/**
 * Delay in ms before retry number `attempt` (1-based: failed attempts so far).
 * 2s doubling per attempt, capped at 60s (Requirement 6.6). Attempts below 1 or
 * non-finite values are treated as attempt 1.
 */
export function nextBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(Math.trunc(attempt), 1) : 1;
  // Clamp the exponent first so very large attempts cannot overflow to Infinity.
  const exponent = Math.min(n - 1, 16);
  return Math.min(RUNNER_BACKOFF_BASE_MS * 2 ** exponent, RUNNER_BACKOFF_CAP_MS);
}

/** True when a model reply has zero characters or only whitespace (Requirement 6.7). */
export function isEmptyReply(text: string | null | undefined): boolean {
  return text == null || text.trim().length === 0;
}

export const EXHAUSTED = "exhausted" as const;

/**
 * Next model to try: the first entry of `fallbackList`, in list order, that is not in
 * `triedModels`. Returns "exhausted" when every model has been tried (Requirement 6.9).
 */
export function pickFallbackModel(
  triedModels: readonly string[],
  fallbackList: readonly string[],
): string | typeof EXHAUSTED {
  const tried = new Set(triedModels);
  const next = fallbackList.find((model) => !tried.has(model));
  return next ?? EXHAUSTED;
}

/**
 * Validate a user-supplied Step timeout. Accepts an integer number of seconds from
 * 1 to 86,400 (the `timeoutSeconds` shape in `src/cron/types.ts`). Anything else,
 * including missing values, strings and non-integers, yields the 600s default with
 * `usedDefault: true` so the caller can append an event naming the rejected value
 * (Requirements 6.11, 6.12).
 */
export function validateTimeoutSeconds(input: unknown): { value: number; usedDefault: boolean } {
  if (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= MIN_STEP_TIMEOUT_SECONDS &&
    input <= MAX_STEP_TIMEOUT_SECONDS
  ) {
    return { value: input, usedDefault: false };
  }
  return { value: DEFAULT_STEP_TIMEOUT_SECONDS, usedDefault: true };
}

/** Maximum tokens, wall-clock time and tool calls for one Step or one Job (Requirement 6.3). */
export type Budget = {
  tokens: number;
  wallClockMs: number;
  toolCalls: number;
};
export type BudgetUsage = Budget;
export type BudgetDimension = keyof Budget;

/**
 * Report which budget dimension, if any, is exceeded. A dimension is exceeded when
 * usage is strictly greater than its limit, so usage equal to the limit is still
 * within budget. If several dimensions are exceeded at once, the first in the order
 * tokens, wallClockMs, toolCalls is reported. The caller records the result in the
 * budget-exceeded event and adds whether the Budget was per-Step or per-Job
 * (Requirements 6.3, 6.4).
 */
export function checkBudget(
  usage: BudgetUsage,
  budget: Budget,
): { exceeded: null | BudgetDimension } {
  const dimensions: BudgetDimension[] = ["tokens", "wallClockMs", "toolCalls"];
  const exceeded = dimensions.find((d) => usage[d] > budget[d]);
  return { exceeded: exceeded ?? null };
}
