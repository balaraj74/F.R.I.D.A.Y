import type { PreActionHook, PreActionRequest } from "../orchestrator/runtime-types.js";
import { isWriteAllowed, type WriteScope } from "./logic.js";

/** File-writing tools in the Orchestrator's Role allowlists. */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;
const PATCH_KEYS = ["patch", "input", "diff"] as const;
/** Target lines of an apply_patch envelope or a unified diff. */
const PATCH_TARGET = /^(?:\*\*\* (?:Add|Update|Delete) File: |\+\+\+ b\/|--- a\/)(.+)$/gm;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every file path a write-tool call names. Empty when none can be found. */
export function writeTargets(args: unknown): string[] {
  if (!isRecord(args)) {
    return [];
  }
  const targets: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string") {
      targets.push(v);
    }
  }
  for (const key of PATCH_KEYS) {
    const v = args[key];
    if (typeof v === "string") {
      for (const m of v.matchAll(PATCH_TARGET)) {
        targets.push(m[1].trim());
      }
    }
  }
  return targets;
}

/**
 * Pre-action hook that confines file writes to the Task's Worktree and declared paths (Req 9.12).
 * Tasks without a registered Worktree are not coding Tasks and pass through. A write call whose
 * target cannot be determined is refused, so the check fails closed. It does not look at `exec`:
 * shell commands are covered by the approval gate in front of this hook.
 */
export function createConfinementHook(
  scopeOf: (jobId: string, taskId: string) => WriteScope | undefined,
): PreActionHook {
  return (action: PreActionRequest) => {
    if (!WRITE_TOOLS.has(action.tool)) {
      return { allow: true };
    }
    const scope = scopeOf(action.jobId, action.taskId);
    if (!scope) {
      return { allow: true };
    }
    const targets = writeTargets(action.args);
    if (targets.length === 0) {
      return { allow: false, reason: `cannot determine the file ${action.tool} would write` };
    }
    const denied = targets.find((t) => !isWriteAllowed(t, scope));
    if (denied !== undefined) {
      return {
        allow: false,
        reason: `${JSON.stringify(denied)} is outside the task worktree and declared paths`,
      };
    }
    return { allow: true };
  };
}
