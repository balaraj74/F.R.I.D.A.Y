/**
 * Pure Loop_Detector logic (Requirements 10.1, 10.2, 10.3, 10.4, 10.10).
 * No I/O: the Step_Runner and Orchestrator feed it data and record the outcome in the Event_Log.
 */

/** One tool call issued by a Task. `arguments` is compared structurally, not by reference. */
export type ToolCall = { tool: string; arguments?: unknown };

export type LoopCause = "repeat" | "similarity";

/**
 * A loop flag raised for a Task. `response` is the action the Orchestrator recorded for the
 * flag (Req 10.3); it is absent while the flag is still being handled.
 */
export type LoopFlag = { cause: LoopCause; response?: LoopResponse };

export type LoopResponse = "change-approach" | "fail-task";

export type LoopConfig = {
  repeatThreshold: number;
  windowSize: number;
  similarityThreshold: number;
};

/** Defaults from Req 10.1 (more than 3 times in 10 Steps) and Req 10.2 (0.85). */
export const DEFAULT_LOOP_CONFIG: Readonly<LoopConfig> = Object.freeze({
  repeatThreshold: 3,
  windowSize: 10,
  similarityThreshold: 0.85,
});

export const LOOP_CONFIG_RANGES = {
  repeatThreshold: { min: 2, max: 20 },
  windowSize: { min: 3, max: 100 },
  similarityThreshold: { min: 0.5, max: 1 },
} as const;

/** JSON with object keys sorted, so `{a:1,b:2}` and `{b:2,a:1}` give the same string. */
function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function callKey(call: ToolCall): string {
  return `${JSON.stringify(call.tool)}|${stableStringify(call.arguments)}`;
}

/**
 * Req 10.1: true iff some identical (tool, arguments) pair occurs MORE than `repeatThreshold`
 * times within some window of `windowSize` consecutive calls. A sequence shorter than the
 * window is treated as a single (partial) window.
 */
export function detectRepeatLoop(
  calls: readonly ToolCall[],
  windowSize: number,
  repeatThreshold: number,
): boolean {
  const keys = calls.map(callKey);
  const counts = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    // Slide the window first: the call at i - windowSize is outside the last `windowSize` calls.
    if (i >= windowSize) {
      const dropped = keys[i - windowSize];
      counts.set(dropped, (counts.get(dropped) ?? 0) - 1);
    }
    const added = keys[i];
    const total = (counts.get(added) ?? 0) + 1;
    counts.set(added, total);
    if (total > repeatThreshold) {
      return true;
    }
  }
  return false;
}

function tokenize(plan: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of plan.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Similarity score in [0, 1] between two plans: Dice coefficient over lowercase word
 * multisets. Identical (including both-empty) plans score 1; plans sharing no words score 0.
 */
export function planSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  let leftSize = 0;
  let rightSize = 0;
  for (const n of left.values()) {
    leftSize += n;
  }
  for (const n of right.values()) {
    rightSize += n;
  }
  if (leftSize === 0 && rightSize === 0) {
    return 1;
  }
  if (leftSize === 0 || rightSize === 0) {
    return 0;
  }
  let shared = 0;
  for (const [token, n] of left) {
    shared += Math.min(n, right.get(token) ?? 0);
  }
  return (2 * shared) / (leftSize + rightSize);
}

/** Req 10.2: true iff the new plan scores at or above `threshold` against any prior plan. */
export function detectPlanSimilarityLoop(
  newPlan: string,
  priorPlans: readonly string[],
  threshold: number,
): boolean {
  return priorPlans.some((prior) => planSimilarity(newPlan, prior) >= threshold);
}

export type LoopConfigValidation = { ok: boolean; invalidField?: string };

function inRange(value: unknown, min: number, max: number, integer: boolean): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    value >= min &&
    value <= max
  );
}

/**
 * Req 10.10: accept iff repeatThreshold is an integer in [2,20], windowSize an integer in
 * [3,100] and similarityThreshold in [0.50,1.00]. On rejection the first invalid field is named.
 */
export function validateLoopConfig(cfg: LoopConfig): LoopConfigValidation {
  const { repeatThreshold: r, windowSize: w, similarityThreshold: s } = LOOP_CONFIG_RANGES;
  if (!inRange(cfg.repeatThreshold, r.min, r.max, true)) {
    return { ok: false, invalidField: "repeatThreshold" };
  }
  if (!inRange(cfg.windowSize, w.min, w.max, true)) {
    return { ok: false, invalidField: "windowSize" };
  }
  if (!inRange(cfg.similarityThreshold, s.min, s.max, false)) {
    return { ok: false, invalidField: "similarityThreshold" };
  }
  return { ok: true };
}

export type ApplyLoopConfigResult = {
  /** The configuration in effect after the attempt: `proposed` if valid, else `current`. */
  config: LoopConfig;
  ok: boolean;
  invalidField?: string;
  /** Present on rejection; names the invalid setting (Req 10.10). */
  error?: string;
};

/** Apply a proposed configuration, keeping `current` unchanged when it is rejected (Req 10.10). */
export function applyLoopConfig(current: LoopConfig, proposed: LoopConfig): ApplyLoopConfigResult {
  const result = validateLoopConfig(proposed);
  if (result.ok) {
    return { config: { ...proposed }, ok: true };
  }
  const field = result.invalidField as keyof typeof LOOP_CONFIG_RANGES;
  const { min, max } = LOOP_CONFIG_RANGES[field];
  return {
    config: current,
    ok: false,
    invalidField: field,
    error: `Invalid loop detector setting "${field}": ${String(proposed[field])} is outside ${min} to ${max}; keeping the previous value.`,
  };
}

/**
 * Req 10.3 / 10.4: `history` holds the Task's loop flags including the one just raised.
 * Earlier flags carry the response recorded for them. If any earlier flag already has a
 * recorded response (the approach was changed), the new flag fails the Task; otherwise it
 * is the first flag and the approach is changed.
 */
export function loopResponse(history: readonly LoopFlag[]): LoopResponse {
  return history.some((flag) => flag.response !== undefined) ? "fail-task" : "change-approach";
}
