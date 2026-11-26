import type { AppendedEvent, NewEvent } from "../store/types.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import { isToolAllowed } from "./roles.js";
import type {
  PreActionHook,
  ToolCallResult,
  ToolDecision,
  ToolGate,
  ToolInvoker,
} from "./runtime-types.js";
import type { Role } from "./types.js";

export type ToolGateOptions = {
  jobId: string;
  taskId: string;
  stepId?: string;
  role: Role;
  appendEvent: (event: NewEvent) => AppendedEvent | void;
  now: () => number;
  preAction?: PreActionHook;
  invoke?: ToolInvoker;
};

/**
 * Enforces the Role allowlist (Requirement 7.5). A tool outside the list is denied, the
 * denial is appended to the Event_Log against the Task, and the agent gets an error back.
 * A failed event append propagates (Req 5.2), so a denial is never silently unrecorded.
 */
export function createToolGate(opts: ToolGateOptions): ToolGate {
  const where = {
    jobId: opts.jobId,
    taskId: opts.taskId,
    ...(opts.stepId !== undefined ? { stepId: opts.stepId } : {}),
  };

  const authorize = async (tool: string, args?: unknown): Promise<ToolDecision> => {
    if (!isToolAllowed(opts.role, tool)) {
      const error = `tool "${tool}" is not permitted for role "${opts.role}"`;
      opts.appendEvent({
        ...where,
        type: ORCHESTRATOR_EVENT_TYPES.toolDenied,
        payload: { tool, role: opts.role, source: "allowlist", reason: error },
        createdAtMs: opts.now(),
      });
      return { allowed: false, error };
    }
    if (opts.preAction) {
      const decision = await opts.preAction({ ...where, role: opts.role, tool, args });
      if (!decision.allow) {
        const error = `tool "${tool}" blocked: ${decision.reason}`;
        opts.appendEvent({
          ...where,
          type: ORCHESTRATOR_EVENT_TYPES.actionBlocked,
          payload: { tool, role: opts.role, source: "pre-action", reason: decision.reason },
          createdAtMs: opts.now(),
        });
        return { allowed: false, error };
      }
    }
    return { allowed: true };
  };

  const call = async (tool: string, args?: unknown): Promise<ToolCallResult> => {
    const decision = await authorize(tool, args);
    if (!decision.allowed) return { ok: false, error: decision.error };
    try {
      const value = opts.invoke
        ? await opts.invoke({ ...where, role: opts.role, tool, args })
        : undefined;
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return { authorize, call };
}
