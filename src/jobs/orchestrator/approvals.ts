import { neverAutoReason } from "../../infra/autonomy-trust.js";
import type { TaskDef, TaskState } from "./types.js";

export type ActionClassification = { neverAuto: boolean; reason: string | null };
export type ApprovalDecision = { at: number; decision: "approve" | "deny" };

/**
 * Whether an action kind (e.g. "git push", "mcp:send") must wait for Sir's approval. Delegates to
 * `neverAutoReason` so the Never_Auto_Action list stays defined in one place (Requirements 8.1, 8.3, 9.9).
 */
export function classifyAction(kind: string): ActionClassification {
  const reason = neverAutoReason(kind);
  return { neverAuto: reason !== null, reason };
}

/**
 * The decision to apply: the earliest by `at`, ties broken by input order. Later decisions are
 * ignored by the caller (Requirement 8.6). Returns null when no decision has arrived.
 */
export function applyFirstDecision(
  decisions: readonly ApprovalDecision[],
): ApprovalDecision | null {
  let first: ApprovalDecision | null = null;
  for (const d of decisions) {
    // Strict "<" keeps the earlier input entry on a tie.
    if (first === null || d.at < first.at) first = d;
  }
  return first ? { decision: first.decision, at: first.at } : null;
}

/**
 * Outcome for a denied Task: "skipped" iff no direct or transitive dependent declares
 * (`requiresOutputFrom`) that it needs the denied Task's output, otherwise "failed" (Requirement 8.8).
 * `_taskStates` is accepted for the Orchestrator's call shape; the outcome depends only on the graph.
 */
export function denyOutcome(
  taskId: string,
  tasks: readonly TaskDef[],
  _taskStates: Readonly<Record<string, TaskState>> = {},
): "skipped" | "failed" {
  const dependents = new Map<string, TaskDef[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(t);
      dependents.set(dep, list);
    }
  }
  const seen = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (seen.has(dependent.id)) continue;
      seen.add(dependent.id);
      if (dependent.requiresOutputFrom?.includes(taskId)) return "failed";
      queue.push(dependent.id);
    }
  }
  return "skipped";
}
