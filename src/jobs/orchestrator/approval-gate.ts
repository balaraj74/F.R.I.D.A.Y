// Approval flow for Never_Auto_Actions inside Jobs (Requirement 8). It plugs into the tool gate's
// `preAction` extension point: an action that `classifyAction` marks never-auto is withheld, only
// its Task moves to waiting_approval, the Notifier asks Sir, and the first decision decides. All
// effects on Tasks and the Event_Log go through injected callbacks, so tests use fakes.
import { commandKinds } from "../../infra/autonomy-trust.js";
import type { NewEvent, TaskState } from "../store/types.js";
import { applyFirstDecision, classifyAction, type ApprovalDecision } from "./approvals.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import type {
  ApprovalDecisionResult,
  ApprovalNotifier,
  PreActionHook,
  PreActionRequest,
} from "./runtime-types.js";

/** Longest command text put in an approval request, so a huge command line cannot flood WhatsApp. */
const ACTION_TEXT_MAX_CHARS = 200;

type Verdict = Awaited<ReturnType<PreActionHook>>;

type Settlement =
  | { kind: "approved" }
  | { kind: "denied"; reason: string }
  | { kind: "discarded"; reason: string };

type Pending = {
  jobId: string;
  taskId: string;
  action: string;
  kind: string;
  previousState: TaskState;
  decisions: ApprovalDecision[];
  applied?: ApprovalDecision;
  settle: (s: Settlement) => void;
};

export type ApprovalGateDeps = {
  now: () => number;
  append: (event: NewEvent) => unknown;
  notifier?: ApprovalNotifier;
  /** The hook that runs for actions that need no approval, and after an approval (confinement etc.). */
  next?: PreActionHook;
  /** Task state according to the Event_Log. */
  taskState: (jobId: string, taskId: string) => TaskState | undefined;
  setTaskState: (
    jobId: string,
    taskId: string,
    to: TaskState,
    reason: string,
    extra?: Record<string, unknown>,
  ) => void;
  /** True once the Job is cancelled or the Task was stopped; nothing may wait for approval then. */
  isStopped: (jobId: string, taskId: string) => boolean;
  /** "skipped" iff no dependent needs the Task's output (Req 8.8). */
  denyOutcome: (jobId: string, taskId: string) => "skipped" | "failed";
  /** The Task is denied: the Orchestrator stops it and records its final state. */
  onDenied: (
    jobId: string,
    taskId: string,
    outcome: "skipped" | "failed",
    reason: string,
    extra: Record<string, unknown>,
  ) => void;
  /** A Task entered or left waiting_approval, so the scheduler can use or reclaim its slot. */
  onWaitingChange: (jobId: string, taskId: string, waiting: boolean) => void;
  onError?: (message: string) => void;
};

export interface ApprovalGate {
  preAction: PreActionHook;
  /** First decision wins; later ones are recorded as ignored and change nothing (Req 8.6). */
  decide(jobId: string, taskId: string, decision: unknown, channel: string): ApprovalDecisionResult;
  /** Drops every pending approval of the Job and cancels those Tasks (Req 8.13). */
  discardJob(jobId: string, reason: string): string[];
  isPending(jobId: string, taskId: string): boolean;
}

const keyOf = (jobId: string, taskId: string) => JSON.stringify([jobId, taskId]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first never-auto kind the tool call performs, with the text shown to Sir. */
function findNeverAuto(
  tool: string,
  args: unknown,
): { kind: string; reason: string; action: string } | null {
  const kinds = [tool];
  const command = isRecord(args) && typeof args.command === "string" ? args.command : undefined;
  if (command !== undefined) {
    try {
      kinds.push(...commandKinds(command));
    } catch {
      // An unparseable command is judged by the tool name alone.
    }
  }
  for (const kind of kinds) {
    const verdict = classifyAction(kind);
    if (verdict.neverAuto) {
      const action =
        command !== undefined ? command.trim().slice(0, ACTION_TEXT_MAX_CHARS) || kind : kind;
      return { kind, reason: verdict.reason ?? "needs approval", action };
    }
  }
  return null;
}

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const pending = new Map<string, Pending>();
  /** Decision applied for a Task's latest approval, to explain later ignored decisions. */
  const decided = new Map<string, ApprovalDecision>();
  /** Per-Task queue: a Task has one approval at a time, which is the unit the Notifier tracks. */
  const lanes = new Map<string, Promise<unknown>>();
  const next: PreActionHook = deps.next ?? (() => ({ allow: true }));

  const notifyRequest = (p: Pending, reason: string): void => {
    if (!deps.notifier) return;
    const failed = (message: string) => {
      try {
        deps.append({
          jobId: p.jobId,
          taskId: p.taskId,
          type: ORCHESTRATOR_EVENT_TYPES.approvalNotifyFailed,
          payload: { action: p.action, message },
          createdAtMs: deps.now(),
        });
      } catch (error) {
        deps.onError?.(`could not record notify failure: ${String(error)}`);
      }
    };
    try {
      void Promise.resolve(
        deps.notifier.requestApproval({
          jobId: p.jobId,
          taskId: p.taskId,
          action: p.action,
          reason,
        }),
      ).then(
        (report) => {
          const r = report as { anyDelivered?: boolean } | undefined;
          if (r && r.anyDelivered === false) failed("no channel delivered the approval request");
        },
        (error: unknown) => failed(error instanceof Error ? error.message : String(error)),
      );
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    }
  };

  const withhold = async (
    action: PreActionRequest,
    hit: { kind: string; reason: string; action: string },
  ): Promise<Verdict> => {
    const { jobId, taskId } = action;
    if (deps.isStopped(jobId, taskId)) return { allow: false, reason: "job cancelled" };

    const key = keyOf(jobId, taskId);
    const previousState: TaskState =
      deps.taskState(jobId, taskId) === "verifying" ? "verifying" : "running";
    const entry: Pending = {
      jobId,
      taskId,
      action: hit.action,
      kind: hit.kind,
      previousState,
      decisions: [],
      settle: () => undefined,
    };
    const settled = new Promise<Settlement>((resolve) => (entry.settle = resolve));
    pending.set(key, entry);
    decided.delete(key);
    try {
      // Only this Task changes state (Req 8.1). The action has not run and will not until approved.
      deps.setTaskState(jobId, taskId, "waiting_approval", `awaiting approval: ${hit.action}`, {
        action: hit.action,
      });
      deps.append({
        jobId,
        taskId,
        ...(action.stepId !== undefined ? { stepId: action.stepId } : {}),
        type: ORCHESTRATOR_EVENT_TYPES.approvalRequested,
        payload: {
          action: hit.action,
          kind: hit.kind,
          tool: action.tool,
          reason: hit.reason,
          previousState,
        },
        createdAtMs: deps.now(),
      });
    } catch (error) {
      pending.delete(key);
      throw error;
    }
    deps.onWaitingChange(jobId, taskId, true);
    notifyRequest(entry, hit.reason);

    const settlement = await settled;
    if (settlement.kind === "approved") return next(action);
    return { allow: false, reason: settlement.reason };
  };

  const preAction: PreActionHook = (action) => {
    const hit = findNeverAuto(action.tool, action.args);
    // Req 8.3: anything else is left to the normal autonomy policy and sends no approval request.
    if (!hit) return next(action);
    const key = keyOf(action.jobId, action.taskId);
    const run = (lanes.get(key) ?? Promise.resolve()).then(() => withhold(action, hit));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    lanes.set(key, tail);
    void tail.then(() => {
      if (lanes.get(key) === tail) lanes.delete(key);
    });
    return run;
  };

  const ignore = (
    jobId: string,
    taskId: string,
    decision: "approve" | "deny",
    channel: string,
    at: number,
    reason: string,
    applied?: ApprovalDecision,
  ): ApprovalDecisionResult => {
    deps.append({
      jobId,
      taskId,
      type: ORCHESTRATOR_EVENT_TYPES.approvalDecisionIgnored,
      payload: {
        decision,
        channel,
        at,
        reason,
        ...(applied ? { appliedDecision: applied.decision, appliedAt: applied.at } : {}),
      },
      createdAtMs: at,
    });
    return { ok: true, applied: false, reason };
  };

  const decide: ApprovalGate["decide"] = (jobId, taskId, rawDecision, channel) => {
    if (rawDecision !== "approve" && rawDecision !== "deny") {
      return { ok: false, error: "invalid-decision" };
    }
    const decision = rawDecision;
    const key = keyOf(jobId, taskId);
    const at = deps.now();
    const entry = pending.get(key);
    if (!entry) {
      const earlier = decided.get(key);
      return ignore(
        jobId,
        taskId,
        decision,
        channel,
        at,
        earlier ? "a decision was already applied" : "no approval is pending for this Task",
        earlier,
      );
    }

    entry.decisions.push({ at, decision });
    const first = applyFirstDecision(entry.decisions);
    if (!first) return { ok: false, error: "invalid-decision" };

    // Record first: if the log write fails nothing has been applied and the approval stays pending.
    deps.append({
      jobId,
      taskId,
      type: ORCHESTRATOR_EVENT_TYPES.approvalDecision,
      payload: { decision: first.decision, channel, at: first.at, action: entry.action },
      createdAtMs: at,
    });
    entry.applied = first;
    pending.delete(key);
    decided.set(key, first);
    // Stops reminders and cancels pending retries right away (Req 8.9).
    try {
      deps.notifier?.decisionApplied(jobId, taskId);
    } catch (error) {
      deps.onError?.(`notifier.decisionApplied failed: ${String(error)}`);
    }

    if (first.decision === "approve") {
      try {
        deps.setTaskState(jobId, taskId, entry.previousState, "approved", {
          decision: "approve",
          channel,
        });
        deps.append({
          jobId,
          taskId,
          type: ORCHESTRATOR_EVENT_TYPES.approvalOutcome,
          payload: { decision: "approve", outcome: "resumed", action: entry.action },
          createdAtMs: deps.now(),
        });
      } finally {
        deps.onWaitingChange(jobId, taskId, false);
        entry.settle({ kind: "approved" });
      }
      return { ok: true, applied: true, decision: "approve", outcome: "resumed" };
    }

    const outcome = deps.denyOutcome(jobId, taskId);
    const reason = `approval denied via ${channel}: ${entry.action}`;
    try {
      deps.append({
        jobId,
        taskId,
        type: ORCHESTRATOR_EVENT_TYPES.approvalOutcome,
        payload: { decision: "deny", outcome, reason, action: entry.action },
        createdAtMs: deps.now(),
      });
      deps.onDenied(jobId, taskId, outcome, reason, { decision: "deny", outcome, channel });
    } finally {
      deps.onWaitingChange(jobId, taskId, false);
      // The withheld action is never performed: the tool call gets an error back.
      entry.settle({ kind: "denied", reason: `denied: ${reason}` });
    }
    return { ok: true, applied: true, decision: "deny", outcome, reason };
  };

  const discardJob: ApprovalGate["discardJob"] = (jobId, reason) => {
    const discarded: string[] = [];
    for (const [key, entry] of pending) {
      if (entry.jobId !== jobId) continue;
      pending.delete(key);
      discarded.push(entry.taskId);
      try {
        deps.notifier?.decisionApplied(jobId, entry.taskId);
      } catch (error) {
        deps.onError?.(`notifier.decisionApplied failed: ${String(error)}`);
      }
      try {
        deps.append({
          jobId,
          taskId: entry.taskId,
          type: ORCHESTRATOR_EVENT_TYPES.approvalDiscarded,
          payload: { action: entry.action, reason },
          createdAtMs: deps.now(),
        });
        deps.setTaskState(jobId, entry.taskId, "cancelled", reason, { action: entry.action });
      } finally {
        deps.onWaitingChange(jobId, entry.taskId, false);
        entry.settle({ kind: "discarded", reason });
      }
    }
    return discarded;
  };

  return {
    preAction,
    decide,
    discardJob,
    isPending: (jobId, taskId) => pending.has(keyOf(jobId, taskId)),
  };
}
