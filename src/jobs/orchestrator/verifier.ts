// Verifier runtime (Requirements 7.8-7.11): checks a Task's Acceptance_Checks with a fresh agent
// in a separate session and records Evidence for every check it can gather.
import type { RunnerClock } from "../runner/deps.js";
import type { AppendedEvent, NewEvent } from "../store/types.js";
import { errorMessage, withTimeout } from "./async.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import type { PlannedTask } from "./plan-parse.js";
import type {
  AgentFactory,
  AgentInstance,
  EvidenceCollector,
  PreActionHook,
  ToolInvoker,
} from "./runtime-types.js";
import { createToolGate } from "./tool-gate.js";
import type { AcceptanceCheck, CheckResult, Evidence, VerificationOutcome } from "./types.js";
import { evaluateCheck, taskVerificationOutcome } from "./verify.js";

/** Default limit for gathering Evidence for one Acceptance_Check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

export type VerifierRuntime = {
  agents: AgentFactory;
  collectEvidence: EvidenceCollector;
  clock: RunnerClock;
  appendEvent: (event: NewEvent) => AppendedEvent | void;
  newId: () => string;
  checkTimeoutMs: number;
  preAction?: PreActionHook;
  invokeTool?: ToolInvoker;
};

/** Agent ids and session keys that ran the Task's Steps. The Verifier must not match any. */
export type ExecutorIdentities = {
  ids: ReadonlySet<string>;
  sessionKeys: ReadonlySet<string>;
};

export type CheckRecord = {
  checkIndex: number;
  check: AcceptanceCheck;
  result: CheckResult;
  evidence?: Evidence;
  /** Why no Evidence exists, when that is the case. */
  error?: string;
};

export type VerificationAttempt = {
  outcome: VerificationOutcome;
  results: CheckResult[];
  records: CheckRecord[];
  verifier?: { id: string; sessionKey: string };
};

/** Records that are not "pass", i.e. the failure Evidence to attach when the Task goes back. */
export function failingRecords(attempt: VerificationAttempt): CheckRecord[] {
  return attempt.records.filter((r) => r.result !== "pass");
}

/**
 * Runs one verification attempt. `attempt` is 1-based and includes this one, so the Task is
 * done only when every check passes with recorded Evidence, goes back to running while
 * attempts remain, and fails on the last one (see `taskVerificationOutcome`).
 */
export async function verifyTask(
  rt: VerifierRuntime,
  req: {
    jobId: string;
    task: PlannedTask;
    attempt: number;
    executors: ExecutorIdentities;
    signal?: AbortSignal;
  },
): Promise<VerificationAttempt> {
  const { jobId, task } = req;
  const noEvidence = (error: string, verifier?: AgentInstance): VerificationAttempt => {
    const records: CheckRecord[] = task.acceptanceChecks.map((check, checkIndex) => ({
      checkIndex,
      check,
      result: "no-evidence",
      error,
    }));
    return finish(rt, req, records, verifier);
  };

  const sessionKey = `agent:verifier:${jobId}:${task.id}:${rt.newId()}`;
  let verifier: AgentInstance;
  try {
    verifier = await rt.agents.create({
      jobId,
      taskId: task.id,
      role: "verifier",
      purpose: "verifier",
      sessionKey,
    });
  } catch (error) {
    return noEvidence(`could not start verifier: ${errorMessage(error)}`);
  }

  try {
    // Req 7.8: never the instance or session that executed the Task's Steps.
    if (
      req.executors.ids.has(verifier.id) ||
      req.executors.sessionKeys.has(verifier.sessionKey) ||
      verifier.sessionKey.length === 0
    ) {
      return noEvidence(
        "verifier must not share an agent instance or session with the Task",
        verifier,
      );
    }

    rt.appendEvent({
      jobId,
      taskId: task.id,
      type: ORCHESTRATOR_EVENT_TYPES.verificationStarted,
      payload: {
        attempt: req.attempt,
        verifierAgentId: verifier.id,
        verifierSessionKey: verifier.sessionKey,
        executorAgentIds: [...req.executors.ids],
      },
      createdAtMs: rt.clock.now(),
    });

    const gate = createToolGate({
      jobId,
      taskId: task.id,
      role: "verifier",
      appendEvent: rt.appendEvent,
      now: () => rt.clock.now(),
      ...(rt.preAction ? { preAction: rt.preAction } : {}),
      ...(rt.invokeTool ? { invoke: rt.invokeTool } : {}),
    });

    const records: CheckRecord[] = [];
    for (const [checkIndex, check] of task.acceptanceChecks.entries()) {
      records.push(await collectOne(rt, req, { checkIndex, check, verifier, gate }));
    }
    return finish(rt, req, records, verifier);
  } finally {
    try {
      await verifier.dispose?.();
    } catch {
      // Disposal is best effort; the verification result is already decided.
    }
  }
}

async function collectOne(
  rt: VerifierRuntime,
  req: { jobId: string; task: PlannedTask; signal?: AbortSignal },
  ctx: {
    checkIndex: number;
    check: AcceptanceCheck;
    verifier: AgentInstance;
    gate: ReturnType<typeof createToolGate>;
  },
): Promise<CheckRecord> {
  const { checkIndex, check } = ctx;
  const base = { jobId: req.jobId, taskId: req.task.id };
  let evidence: Evidence | undefined;
  let error: string | undefined;
  try {
    const out = await withTimeout(
      rt.clock,
      rt.checkTimeoutMs,
      (signal) =>
        rt.collectEvidence({
          ...base,
          check,
          checkIndex,
          verifier: ctx.verifier,
          gate: ctx.gate,
          signal,
        }),
      req.signal,
    );
    if (out.timedOut) error = `evidence collection timed out after ${rt.checkTimeoutMs}ms`;
    else evidence = out.value;
  } catch (e) {
    error = `evidence collection failed: ${errorMessage(e)}`;
  }

  if (evidence === undefined) {
    const reason = error ?? "no evidence was produced";
    rt.appendEvent({
      ...base,
      type: ORCHESTRATOR_EVENT_TYPES.evidenceFailed,
      payload: { checkIndex, checkType: check.type, error: reason },
      createdAtMs: rt.clock.now(),
    });
    return { checkIndex, check, result: "no-evidence", error: reason };
  }

  // Evidence is only counted once it is in the log (Req 7.9).
  const result = evaluateCheck(check, evidence);
  rt.appendEvent({
    ...base,
    type: ORCHESTRATOR_EVENT_TYPES.evidenceRecorded,
    payload: { checkIndex, checkType: check.type, evidence, result },
    createdAtMs: rt.clock.now(),
  });
  return { checkIndex, check, result, evidence };
}

function finish(
  rt: VerifierRuntime,
  req: { jobId: string; task: PlannedTask; attempt: number },
  records: CheckRecord[],
  verifier?: AgentInstance,
): VerificationAttempt {
  const results = records.map((r) => r.result);
  const outcome = taskVerificationOutcome(results, req.attempt);
  rt.appendEvent({
    jobId: req.jobId,
    taskId: req.task.id,
    type: ORCHESTRATOR_EVENT_TYPES.verificationResult,
    payload: { attempt: req.attempt, outcome, results, records },
    createdAtMs: rt.clock.now(),
  });
  return {
    outcome,
    results,
    records,
    ...(verifier ? { verifier: { id: verifier.id, sessionKey: verifier.sessionKey } } : {}),
  };
}
