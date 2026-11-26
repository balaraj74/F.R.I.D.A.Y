// Turns raw Planner output into a validated, step-sized Task graph (Requirements 6.5, 7.1, 7.4).
// The Planner is a model, so its output is untrusted `unknown`: shape errors are reported as
// plan validation errors (naming the Task id where there is one) instead of throwing.
import { MAX_STEP_REPLY_TOKENS, splitStepEstimate } from "../runner/step-sizing.js";
import { validatePlan } from "./plan.js";
import { ROLES, type AcceptanceCheck, type Role, type TaskDef } from "./types.js";

/** Expected reply size assumed for a Task whose plan gives no estimate. */
export const DEFAULT_TASK_REPLY_ESTIMATE_TOKENS = 4_000;
/** A Task is split into at most this many Steps; larger estimates are a plan error. */
export const MAX_STEPS_PER_TASK = 100;

export type PlannedStep = {
  /** 1-based position within the Task. */
  index: number;
  /** Expected reply size. Always at most `MAX_STEP_REPLY_TOKENS` (Req 6.5). */
  expectedReplyTokens: number;
};

export type PlannedTask = TaskDef & {
  title?: string;
  instructions?: string;
  steps: PlannedStep[];
};

export type ParsedPlan = { ok: true; tasks: PlannedTask[] } | { ok: false; errors: string[] };

/**
 * Splits a Task's expected reply into Steps that each fit under the Proxy output cap.
 * Throws RangeError for a non-finite estimate or one needing more than `MAX_STEPS_PER_TASK`.
 */
export function sizeTaskSteps(estimateTokens: number): PlannedStep[] {
  if (Math.ceil(Math.max(estimateTokens, 0) / MAX_STEP_REPLY_TOKENS) > MAX_STEPS_PER_TASK) {
    throw new RangeError(
      `estimated reply of ${estimateTokens} tokens needs more than ${MAX_STEPS_PER_TASK} steps`,
    );
  }
  return splitStepEstimate(estimateTokens).map((expectedReplyTokens, i) => ({
    index: i + 1,
    expectedReplyTokens,
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseCheck(raw: unknown): AcceptanceCheck | string {
  if (!isRecord(raw)) return "must be an object";
  switch (raw.type) {
    case "tests_pass":
      return isNonEmptyString(raw.command)
        ? { type: "tests_pass", command: raw.command }
        : "tests_pass needs a non-empty command";
    case "file_exists":
      return isNonEmptyString(raw.path)
        ? { type: "file_exists", path: raw.path }
        : "file_exists needs a non-empty path";
    case "exit_code":
      if (!isNonEmptyString(raw.command)) return "exit_code needs a non-empty command";
      if (typeof raw.expected !== "number" || !Number.isInteger(raw.expected)) {
        return "exit_code needs an integer expected code";
      }
      return { type: "exit_code", command: raw.command, expected: raw.expected };
    case "rubric":
      if (
        !Array.isArray(raw.items) ||
        raw.items.length === 0 ||
        !raw.items.every(isNonEmptyString)
      ) {
        return "rubric needs a non-empty list of non-empty items";
      }
      return { type: "rubric", items: [...(raw.items as string[])] };
    default:
      return "type must be one of tests_pass, file_exists, exit_code, rubric";
  }
}

function parseTask(raw: unknown, position: number, errors: string[]): PlannedTask | null {
  if (!isRecord(raw)) {
    errors.push(`task #${position + 1}: must be an object`);
    return null;
  }
  if (!isNonEmptyString(raw.id)) {
    errors.push(`task #${position + 1}: id must be a non-empty string`);
    return null;
  }
  const id = raw.id;
  const before = errors.length;

  if (!ROLES.some((r) => r === raw.role)) {
    errors.push(`task ${id}: invalid role (expected one of ${ROLES.join(", ")})`);
  }
  let dependsOn: string[] = [];
  if (!Array.isArray(raw.dependsOn) || !raw.dependsOn.every((d) => typeof d === "string")) {
    errors.push(`task ${id}: dependsOn must be an array of task ids`);
  } else {
    dependsOn = [...(raw.dependsOn as string[])];
  }

  const checks: AcceptanceCheck[] = [];
  if (!Array.isArray(raw.acceptanceChecks)) {
    errors.push(`task ${id}: acceptanceChecks must be an array`);
  } else {
    raw.acceptanceChecks.forEach((c, i) => {
      const parsed = parseCheck(c);
      if (typeof parsed === "string")
        errors.push(`task ${id}: acceptance check #${i + 1}: ${parsed}`);
      else checks.push(parsed);
    });
  }

  let requiresOutputFrom: string[] | undefined;
  if (raw.requiresOutputFrom !== undefined) {
    if (
      !Array.isArray(raw.requiresOutputFrom) ||
      !raw.requiresOutputFrom.every((d) => typeof d === "string")
    ) {
      errors.push(`task ${id}: requiresOutputFrom must be an array of task ids`);
    } else {
      requiresOutputFrom = [...(raw.requiresOutputFrom as string[])];
    }
  }

  let steps: PlannedStep[] = [];
  const estimate = raw.estimatedReplyTokens ?? DEFAULT_TASK_REPLY_ESTIMATE_TOKENS;
  if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
    errors.push(`task ${id}: estimatedReplyTokens must be a finite number`);
  } else {
    try {
      steps = sizeTaskSteps(estimate);
    } catch (error) {
      errors.push(`task ${id}: ${(error as Error).message}`);
    }
  }

  if (errors.length > before) return null;
  return {
    id,
    role: raw.role as Role,
    dependsOn,
    acceptanceChecks: checks,
    ...(requiresOutputFrom ? { requiresOutputFrom } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {}),
    steps,
  };
}

/**
 * Parses and validates Planner output: a JSON string, an array of Tasks or `{ tasks: [...] }`.
 * On success every Task has Steps sized to the Proxy cap; otherwise every error found is
 * returned so the correction request can name them all.
 */
export function parsePlanOutput(raw: unknown): ParsedPlan {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, errors: ["planner output is not valid JSON"] };
    }
  }
  const list = Array.isArray(value) ? value : isRecord(value) ? value.tasks : undefined;
  if (!Array.isArray(list)) {
    return { ok: false, errors: ["planner output must be an array of tasks or { tasks: [...] }"] };
  }

  const errors: string[] = [];
  const tasks: PlannedTask[] = [];
  list.forEach((item, i) => {
    const task = parseTask(item, i, errors);
    if (task) tasks.push(task);
  });
  // Structural rules (count, ids, dependencies, cycles) only make sense on a fully parsed graph.
  if (errors.length > 0) return { ok: false, errors };

  const validation = validatePlan(tasks);
  return validation.ok ? { ok: true, tasks } : { ok: false, errors: validation.errors };
}
