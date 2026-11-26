// Orchestrator runtime (Requirement 7): creates a Job, has the Planner produce a Task graph,
// runs ready Tasks in parallel up to the concurrency limit, and has a separate Verifier decide
// when each Task is done. Every state change is an event in the Event_Log; the Job and Task
// views are projections of it. Agents, clock, database and evidence collection are injected.
import crypto from "node:crypto";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requestTransition, TERMINAL_JOB_STATES } from "../engine/state-machine.js";
import { nodeRunnerFs, systemClock } from "../runner/deps.js";
import { RUNNER_EVENT_TYPES } from "../runner/events.js";
import type { BudgetUsage } from "../runner/helpers.js";
import { runStep, type StepRunnerDeps, type StepRunRequest } from "../runner/step-runner.js";
import { appendEvent, loadEvents } from "../store/log.js";
import { EVENT_TYPES, projectJobState } from "../store/project.js";
import type { JobState, NewEvent, TaskState } from "../store/types.js";
import { buildAdoption, type Adoption } from "./adopt.js";
import { createApprovalGate } from "./approval-gate.js";
import { denyOutcome } from "./approvals.js";
import { errorMessage } from "./async.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import { createLoopController, type TaskLoopState } from "./loop-control.js";
import { ABORTED, JobControl, raceAbort } from "./job-control.js";
import { DEFAULT_PLAN_TIMEOUT_MS, planJob } from "./planner.js";
import type { PlannedTask } from "./plan-parse.js";
import {
  readyTasks,
  schedule,
  isValidConcurrencyLimit,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
} from "./schedule.js";
import {
  JobControlError,
  type AdoptJobResult,
  type AgentInstance,
  type ApprovalDecisionResult,
  type CreateJobInput,
  type JobView,
  type Orchestrator,
  type OrchestratorConfig,
  type OrchestratorDeps,
  type TaskView,
} from "./runtime-types.js";
import { createToolGate } from "./tool-gate.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  failingRecords,
  verifyTask,
  type CheckRecord,
  type ExecutorIdentities,
} from "./verifier.js";

const log = createSubsystemLogger("jobs/orchestrator");

const DEFAULT_CONFIG: OrchestratorConfig = {
  concurrencyLimit: 4,
  planTimeoutMs: DEFAULT_PLAN_TIMEOUT_MS,
  checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
  stepBudget: { tokens: 500_000, wallClockMs: 3_600_000, toolCalls: 500 },
  jobBudget: { tokens: 5_000_000, wallClockMs: 86_400_000, toolCalls: 5_000 },
  models: ["default"],
  stepTimeoutSeconds: 600,
};

/**
 * How long `cancelJob` waits for running Steps to wind down before it releases their Leases and
 * marks the Job cancelled anyway. Leaves 10s of the 30s budget (Req 8.12) for the final writes.
 */
export const CANCEL_SETTLE_MS = 20_000;

/** Task states that no longer change. */
const FINISHED_TASK_STATES: readonly TaskState[] = ["done", "failed", "skipped", "cancelled"];

/** Longest evidence excerpt written into progress.md feedback. */
const FEEDBACK_EVIDENCE_MAX_CHARS = 500;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertConcurrency(limit: unknown): asserts limit is number {
  if (!isValidConcurrencyLimit(limit)) {
    throw new RangeError(
      `concurrency limit must be an integer ${MIN_CONCURRENCY}-${MAX_CONCURRENCY}, got ${String(limit)}`,
    );
  }
}

function describeRecords(records: readonly CheckRecord[]): string {
  return records
    .map(
      (r) =>
        `check #${r.checkIndex + 1} (${r.check.type}): ${r.result}${r.error ? ` - ${r.error}` : ""}`,
    )
    .join("; ");
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const cfg: OrchestratorConfig = { ...DEFAULT_CONFIG, ...deps.config };
  assertConcurrency(cfg.concurrencyLimit);
  const clock = deps.clock ?? systemClock;
  const fs = deps.fs ?? nodeRunnerFs;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const progressDir = cfg.progressDir ?? path.join(resolveStateDir(), "jobs", "progress");
  const active = new Map<string, Promise<void>>();
  const controls = new Map<string, JobControl>();
  const runs = new Map<string, JobRun>();
  /** Aborts one Task (denied approval) without touching the rest of the Job. */
  const taskStops = new Map<string, AbortController>();
  const denials = new Map<string, { outcome: "skipped" | "failed"; reason: string }>();
  /** Tasks failed by the Loop_Detector after a repeat flag (Req 10.4). */
  const loopFailures = new Map<string, string>();
  const loopController = createLoopController(deps.loopControl, cfg.models, (m) => log.error(m));
  const taskKey = (jobId: string, taskId: string) => `${jobId}\u0000${taskId}`;

  const append = (e: NewEvent) =>
    appendEvent(deps.db, { ...e, createdAtMs: e.createdAtMs ?? clock.now() });

  const transition = (jobId: string, to: JobState, reason: string): void => {
    const res = requestTransition(deps.db, jobId, to, { reason, nowMs: clock.now() });
    if (!res.ok) throw new Error(`job ${jobId}: cannot move to ${to} (${res.error.kind})`);
  };

  const setTaskState = (
    jobId: string,
    taskId: string,
    to: TaskState,
    reason: string,
    extra: Record<string, unknown> = {},
  ): void => {
    append({
      jobId,
      taskId,
      type: EVENT_TYPES.taskStateChanged,
      payload: { to, reason, ...extra },
    });
  };

  const jobStateOf = (jobId: string): JobState | undefined =>
    projectJobState(loadEvents(deps.db, jobId)).jobs[jobId]?.state;

  const taskStateOf = (jobId: string, taskId: string): TaskState | undefined =>
    projectJobState(loadEvents(deps.db, jobId)).jobs[jobId]?.tasks[taskId]?.state;

  // Approvals (Requirement 8): a never-auto action withholds only its own Task.
  const approvals = createApprovalGate({
    now: () => clock.now(),
    append,
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    ...(deps.preAction ? { next: deps.preAction } : {}),
    taskState: taskStateOf,
    setTaskState,
    isStopped: (jobId, taskId) =>
      controls.get(jobId)?.cancelled === true ||
      taskStops.get(taskKey(jobId, taskId))?.signal.aborted === true,
    denyOutcome: (jobId, taskId) => denyOutcome(taskId, runs.get(jobId)?.tasks ?? []),
    onDenied: (jobId, taskId, outcome, reason, extra) => {
      denials.set(taskKey(jobId, taskId), { outcome, reason });
      // Recorded before the Task is stopped, so the log shows the outcome and why (Req 8.8).
      setTaskState(jobId, taskId, outcome, reason, extra);
      taskStops.get(taskKey(jobId, taskId))?.abort(new Error("approval denied"));
    },
    onWaitingChange: (jobId, taskId, waiting) => {
      const run = runs.get(jobId);
      if (waiting) run?.waiting.add(taskId);
      else run?.waiting.delete(taskId);
      // A waiting Task does not hold a concurrency slot, so independent Tasks may start (Req 8.2).
      controls.get(jobId)?.notify();
    },
    onError: (message) => log.error(message),
  });

  // ------------------------------------------------------------------------------------
  // Running one Task: Steps, then verification, looping back on failed checks
  // ------------------------------------------------------------------------------------

  type JobRun = {
    jobId: string;
    tasks: PlannedTask[];
    /** Final reply of each finished Task, handed to its dependents as upstream results. */
    results: Map<string, string>;
    /** Usage of finished Steps. Parallel Steps see a snapshot, so the Job budget is approximate. */
    usage: BudgetUsage;
    ctl: JobControl;
    /** Tasks currently in waiting_approval. They do not count against the concurrency limit. */
    waiting: Set<string>;
    /** Loop_Detector state per Task (Req 10.3, 10.4). */
    loops: Map<string, TaskLoopState>;
    /** Steps that finished before a restart, with their replies. They are not run again. */
    completedSteps: Map<string, string>;
    /** Set for an adopted Job: where each Task restarts and which Tasks were already finished. */
    adopted?: Adoption;
  };

  /**
   * Req 13.11: a Step that ended because the Proxy was unreachable waits for the Proxy to respond,
   * then gets one retry. Without a configured recovery the Step simply stays failed.
   */
  async function retryAfterProxyRestart(
    run: JobRun,
    task: PlannedTask,
    stepId: string,
    reason: string,
    stop: AbortSignal,
  ): Promise<
    { retry: true; stopped?: never } | { retry: false; stopped: boolean; reason: string }
  > {
    const recovery = deps.proxyRecovery;
    if (!recovery) return { retry: false, stopped: false, reason: "no Proxy recovery configured" };
    const req = { jobId: run.jobId, taskId: task.id, stepId, reason, signal: stop };
    let decision: Awaited<ReturnType<typeof recovery.awaitRetry>>;
    try {
      decision = await recovery.awaitRetry(req);
    } catch (error) {
      decision = { retry: false, reason: `Proxy recovery failed: ${errorMessage(error)}` };
    }
    if (stop.aborted) return { retry: false, stopped: true, reason: "stopped" };
    if (!decision.retry) {
      await reportProxyRetryFailed(run, task, stepId, decision.reason);
      return { retry: false, stopped: false, reason: decision.reason };
    }
    append({
      jobId: run.jobId,
      taskId: task.id,
      stepId,
      type: ORCHESTRATOR_EVENT_TYPES.proxyRetryScheduled,
      payload: { respondedAtMs: decision.respondedAtMs, retryAtMs: clock.now() },
    });
    return { retry: true };
  }

  /** Records that the Step cannot continue after a Proxy restart and has the user told (Req 13.11). */
  async function reportProxyRetryFailed(
    run: JobRun,
    task: PlannedTask,
    stepId: string,
    reason: string,
  ): Promise<void> {
    append({
      jobId: run.jobId,
      taskId: task.id,
      stepId,
      type: ORCHESTRATOR_EVENT_TYPES.proxyRetryFailed,
      payload: { reason },
    });
    try {
      await deps.proxyRecovery?.retryFailed({
        jobId: run.jobId,
        taskId: task.id,
        stepId,
        reason,
        signal: new AbortController().signal,
      });
    } catch (error) {
      log.error(
        `could not notify about failed Proxy retry for job ${run.jobId}: ${errorMessage(error)}`,
      );
    }
  }

  type StepsOutcome = { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "stopped" };

  async function runSteps(
    run: JobRun,
    task: PlannedTask,
    agent: AgentInstance,
    round: number,
    stop: AbortSignal,
  ): Promise<StepsOutcome> {
    const progressPath = path.join(progressDir, run.jobId, `${task.id}.md`);
    // Req 6.1: a Step sees only the progress file and its upstream Tasks' results.
    const upstream = task.dependsOn.map((id) => ({
      taskId: id,
      result: run.results.get(id) ?? "",
    }));
    let last = "";
    const loop = loopStateOf(run, task.id);
    for (const step of task.steps) {
      const stepId = `${task.id}.${round}.${step.index}`;
      // Req 13.10: a Step that finished before a restart is never run again.
      const finished = run.completedSteps.get(stepId);
      if (finished !== undefined) {
        last = finished;
        continue;
      }
      // Req 8.10: while paused no new Step starts. A Step that is already running finishes.
      await run.ctl.waitWhilePaused();
      if (stop.aborted) return { kind: "stopped" };
      // Req 10.5, 10.6: planning and verification use the main model, low-complexity Steps the
      // fast one, each with its ordered fallback list. A first loop flag may have moved this up.
      const modelClass = loopController.classify(task, step);
      loop.noteStep(modelClass);
      const stepDeps: StepRunnerDeps = {
        runTurn: (req) =>
          agent.runTurn({
            ...req,
            agentId: agent.id,
            sessionKey: agent.sessionKey,
            role: task.role,
            task: {
              id: task.id,
              ...(task.title !== undefined ? { title: task.title } : {}),
              ...(task.instructions !== undefined ? { instructions: task.instructions } : {}),
              acceptanceChecks: task.acceptanceChecks,
            },
            step: { ...step, count: task.steps.length },
            round,
            gate: createToolGate({
              jobId: run.jobId,
              taskId: task.id,
              stepId: req.stepId,
              role: task.role,
              appendEvent: append,
              now: () => clock.now(),
              preAction: async (action) => {
                const verdict = await guardLoop(run, task, action);
                return verdict.allow ? approvals.preAction(action) : verdict;
              },
              ...(deps.invokeTool ? { invoke: deps.invokeTool } : {}),
            }),
          }),
        // Tag Step events with the agent so the log shows who ran what (and who verified).
        appendEvent: (e) =>
          append(isRecord(e.payload) ? { ...e, payload: { ...e.payload, agentId: agent.id } } : e),
        clock,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        fs,
      };
      const stepReq: StepRunRequest = {
        jobId: run.jobId,
        taskId: task.id,
        stepId,
        progressPath,
        upstream,
        models: loop.modelsFor(modelClass),
        stepBudget: cfg.stepBudget,
        jobBudget: cfg.jobBudget,
        jobUsageBefore: { ...run.usage },
        cancelSignal: stop,
        ...(cfg.stepTimeoutSeconds !== undefined ? { timeoutSeconds: cfg.stepTimeoutSeconds } : {}),
      };
      let outcome = await runStep(stepDeps, stepReq);
      let failureNote = "";
      if (outcome.status === "failed" && outcome.failure === "proxy-unreachable") {
        const recovered = await retryAfterProxyRestart(run, task, stepId, outcome.reason, stop);
        if (recovered.stopped) return { kind: "stopped" };
        if (recovered.retry) {
          // Req 13.11: exactly one more attempt, started as soon as the Proxy responds.
          outcome = await runStep(stepDeps, {
            ...stepReq,
            jobUsageBefore: { ...run.usage },
            maxAttempts: 1,
          });
          if (outcome.status !== "completed" && outcome.status !== "cancelled") {
            await reportProxyRetryFailed(
              run,
              task,
              stepId,
              "the retry after the Proxy restart failed",
            );
            failureNote = " (retry after Proxy restart failed)";
          }
        } else {
          failureNote = ` (${recovered.reason})`;
        }
      }
      if (outcome.status === "completed") {
        run.usage = {
          tokens: run.usage.tokens + outcome.usage.tokens,
          wallClockMs: run.usage.wallClockMs + outcome.usage.wallClockMs,
          toolCalls: run.usage.toolCalls + outcome.usage.toolCalls,
        };
        last = outcome.reply;
      } else if (outcome.status === "failed") {
        return { kind: "failed", reason: `step ${stepId} failed: ${outcome.reason}${failureNote}` };
      } else if (outcome.status === "cancelled") {
        return { kind: "stopped" };
      } else {
        return { kind: "failed", reason: `step ${stepId} stopped: lease expired` };
      }
    }
    run.results.set(task.id, last);
    return { kind: "ok" };
  }

  function loopStateOf(run: JobRun, taskId: string): TaskLoopState {
    let state = run.loops.get(taskId);
    if (!state) {
      state = loopController.newTask();
      run.loops.set(taskId, state);
    }
    return state;
  }

  /**
   * Feeds one tool call to the Task's Loop_Detector (Req 10.1). On a first flag the approach is
   * changed (a stronger model for later Steps, or a plan note in progress.md) and the choice is
   * logged. On a repeat flag the Task is failed with its events and progress file kept, and the
   * user is told. Both happen synchronously with the call, well inside the 5s allowed.
   */
  async function guardLoop(
    run: JobRun,
    task: PlannedTask,
    action: { stepId?: string; tool: string; args?: unknown },
  ): Promise<{ allow: true } | { allow: false; reason: string }> {
    const decision = loopStateOf(run, task.id).recordCall({
      tool: action.tool,
      arguments: action.args,
    });
    if (!decision.flagged) return { allow: true };
    const where = {
      jobId: run.jobId,
      taskId: task.id,
      ...(action.stepId !== undefined ? { stepId: action.stepId } : {}),
    };
    const payload = {
      cause: "repeat",
      tool: action.tool,
      response: decision.response,
      flagNumber: decision.flagNumber,
      ...(decision.action ? { action: decision.action } : {}),
    };
    if (decision.response === "change-approach") {
      append({ ...where, type: ORCHESTRATOR_EVENT_TYPES.loopFlagged, payload });
      await writeLoopNote(run, task, action.tool);
      return {
        allow: false,
        reason: "loop detected: the same call keeps repeating, so change your approach",
      };
    }
    const label = task.title ? `${task.id} (${task.title})` : task.id;
    const reason = `repeated loop: ${action.tool} kept repeating after the approach was changed`;
    append({ ...where, type: ORCHESTRATOR_EVENT_TYPES.loopFlagged, payload });
    const key = taskKey(run.jobId, task.id);
    loopFailures.set(key, reason);
    // Recorded before the Task is stopped, so the log shows the cause (Req 10.4).
    setTaskState(run.jobId, task.id, "failed", reason, { cause: "loop" });
    try {
      loopController.notify(`Task ${label} of job ${run.jobId} failed: ${reason}.`);
    } catch (error) {
      log.error(`could not notify about looping task ${task.id}: ${errorMessage(error)}`);
    }
    taskStops.get(key)?.abort(new Error("repeated loop"));
    return { allow: false, reason };
  }

  /** Tells the Task's next fresh-context Steps to take another approach. */
  async function writeLoopNote(run: JobRun, task: PlannedTask, tool: string): Promise<void> {
    const progressPath = path.join(progressDir, run.jobId, `${task.id}.md`);
    try {
      const previous = (await fs.readText(progressPath)) ?? "# Progress\n";
      await fs.writeText(
        progressPath,
        `${previous.replace(/\s+$/, "")}\n\n## Loop detected\nThe call to ${tool} kept repeating. Take a different approach.\n`,
      );
    } catch (error) {
      append({
        jobId: run.jobId,
        taskId: task.id,
        type: RUNNER_EVENT_TYPES.progressWriteFailed,
        payload: { path: progressPath, message: errorMessage(error) },
      });
    }
  }

  /** Puts the failure Evidence where the next round's fresh-context Steps will read it. */
  async function writeFeedback(
    run: JobRun,
    task: PlannedTask,
    attempt: number,
    records: readonly CheckRecord[],
  ): Promise<void> {
    const progressPath = path.join(progressDir, run.jobId, `${task.id}.md`);
    const lines = records.map((r) => {
      const evidence = r.evidence
        ? JSON.stringify(r.evidence).slice(0, FEEDBACK_EVIDENCE_MAX_CHARS)
        : "none";
      return `- check #${r.checkIndex + 1} (${r.check.type}): ${r.result}; evidence: ${evidence}${r.error ? `; ${r.error}` : ""}`;
    });
    try {
      const previous = (await fs.readText(progressPath)) ?? "# Progress\n";
      await fs.writeText(
        progressPath,
        `${previous.replace(/\s+$/, "")}\n\n## Verification failed (attempt ${attempt})\n${lines.join("\n")}\n`,
      );
    } catch (error) {
      append({
        jobId: run.jobId,
        taskId: task.id,
        type: RUNNER_EVENT_TYPES.progressWriteFailed,
        payload: { path: progressPath, message: errorMessage(error) },
      });
    }
  }

  type TaskFinal = "done" | "failed" | "skipped" | "cancelled";

  async function runTask(run: JobRun, task: PlannedTask): Promise<TaskFinal> {
    const { jobId } = run;
    const key = taskKey(jobId, task.id);
    const taskStop = new AbortController();
    taskStops.set(key, taskStop);
    // Aborts when the Job is cancelled or this Task's approval is denied.
    const stop = AbortSignal.any([run.ctl.signal, taskStop.signal]);
    /** Why the Task stopped. The state was already recorded by `cancelJob` or the approval gate. */
    const stopped = (): TaskFinal =>
      denials.get(key)?.outcome ?? (loopFailures.has(key) ? "failed" : "cancelled");
    const executors = { ids: new Set<string>(), sessionKeys: new Set<string>() };
    let agent: AgentInstance | undefined;
    try {
      const resume = run.adopted?.resume.get(task.id);
      const resumed = run.adopted !== undefined && run.adopted.taskStates[task.id] !== "pending";
      setTaskState(jobId, task.id, "running", resumed ? "resumed after restart" : "started");
      agent = await deps.agents.create({
        jobId,
        taskId: task.id,
        role: task.role,
        purpose: "task",
        sessionKey: `agent:task:${jobId}:${task.id}:${newId()}`,
      });
      executors.ids.add(agent.id);
      executors.sessionKeys.add(agent.sessionKey);

      for (let round = resume?.round ?? 1, attempt = resume?.attempt ?? 0; ; round++) {
        const steps = await runSteps(run, task, agent, round, stop);
        if (steps.kind === "stopped" || stop.aborted) return stopped();
        if (steps.kind === "failed") {
          setTaskState(jobId, task.id, "failed", steps.reason);
          return "failed";
        }

        setTaskState(jobId, task.id, "verifying", "all steps completed");
        attempt += 1;
        const verification = await raceAbort(
          stop,
          verifyTask(
            {
              agents: deps.agents,
              collectEvidence: deps.collectEvidence,
              clock,
              appendEvent: append,
              newId,
              checkTimeoutMs: cfg.checkTimeoutMs,
              preAction: approvals.preAction,
              ...(deps.invokeTool ? { invokeTool: deps.invokeTool } : {}),
            },
            { jobId, task, attempt, executors: executors as ExecutorIdentities },
          ),
        );
        if (verification === ABORTED || stop.aborted) return stopped();

        if (verification.outcome === "done") {
          setTaskState(jobId, task.id, "done", `verified on attempt ${attempt}`);
          return "done";
        }
        const failing = failingRecords(verification);
        const evidence = { attempt, records: failing };
        if (verification.outcome === "retry") {
          await writeFeedback(run, task, attempt, failing);
          if (stop.aborted) return stopped();
          setTaskState(
            jobId,
            task.id,
            "running",
            `verification attempt ${attempt} failed: ${describeRecords(failing)}`,
            { evidence },
          );
          continue;
        }
        setTaskState(
          jobId,
          task.id,
          "failed",
          `verification failed after ${attempt} attempts: ${describeRecords(failing)}`,
          { evidence },
        );
        return "failed";
      }
    } catch (error) {
      if (stop.aborted) return stopped();
      log.error(`task ${task.id} of job ${jobId} errored: ${errorMessage(error)}`);
      try {
        setTaskState(jobId, task.id, "failed", `orchestrator error: ${errorMessage(error)}`);
      } catch {
        // The log itself is failing; the Job-level handler reports it.
      }
      return "failed";
    } finally {
      taskStops.delete(key);
      try {
        await agent?.dispose?.();
      } catch {
        // Best effort; the Task outcome is already recorded.
      }
    }
  }

  // ------------------------------------------------------------------------------------
  // Scheduling Tasks and driving a Job to a terminal state
  // ------------------------------------------------------------------------------------

  async function executePlan(
    run: JobRun,
    limit: number,
  ): Promise<{ failed: string[]; skipped: string[]; deniedSkipped: string[] }> {
    const { ctl } = run;
    const states: Record<string, TaskState> = {};
    for (const t of run.tasks) {
      // After a restart, Tasks that had finished stay finished; the others start over (Req 13.10).
      const before = run.adopted?.taskStates[t.id];
      states[t.id] =
        before !== undefined && FINISHED_TASK_STATES.includes(before) ? before : "pending";
    }
    const byId = new Map(run.tasks.map((t) => [t.id, t]));
    const running = new Map<string, Promise<void>>();
    /**
     * Tasks skipped because Sir denied their action and no dependent needs their output
     * (Req 8.8). The graph has already decided those dependents can proceed, so they count as
     * satisfied dependencies.
     */
    const deniedSkipped = new Set<string>(run.adopted?.deniedSkipped ?? []);
    const view = (): Record<string, TaskState> => {
      const copy = { ...states };
      for (const id of deniedSkipped) copy[id] = "done";
      return copy;
    };

    for (;;) {
      if (ctl.cancelled) break;
      if (ctl.paused) {
        // Req 8.10: running Tasks continue; nothing new starts until resume.
        if (running.size === 0) await ctl.waitWhilePaused();
        else await Promise.race([...running.values(), ctl.changed()]);
        continue;
      }
      // Req 7.6: start ready Tasks up to the limit, and more as running Tasks finish. A Task in
      // waiting_approval holds no slot, so independent Tasks keep starting (Req 8.2).
      const slotsUsed = running.size - run.waiting.size;
      for (const id of schedule(readyTasks(run.tasks, view()), slotsUsed, limit)) {
        const task = byId.get(id) as PlannedTask;
        states[id] = "running";
        running.set(
          id,
          runTask(run, task).then((final) => {
            states[id] = final;
            if (final === "skipped") deniedSkipped.add(id);
            running.delete(id);
            run.waiting.delete(id);
          }),
        );
      }
      if (running.size === 0) break;
      await Promise.race([...running.values(), ctl.changed()]);
    }

    if (ctl.cancelled) {
      // Let stopped Tasks finish releasing their Leases before the Job is marked cancelled.
      await Promise.allSettled(running.values());
      return { failed: [], skipped: [], deniedSkipped: [...deniedSkipped] };
    }

    // Req 7.11: whatever is still pending depends on a failed Task and is never started.
    const skipped: string[] = [];
    for (const task of run.tasks) {
      if (states[task.id] !== "pending") continue;
      const blocker = task.dependsOn.find(
        (d) => (states[d] === "failed" || states[d] === "skipped") && !deniedSkipped.has(d),
      );
      setTaskState(
        run.jobId,
        task.id,
        "skipped",
        `dependency ${blocker ?? "unknown"} did not complete`,
      );
      states[task.id] = "skipped";
      skipped.push(task.id);
    }
    return {
      failed: run.tasks.filter((t) => states[t.id] === "failed").map((t) => t.id),
      skipped,
      deniedSkipped: [...deniedSkipped],
    };
  }

  async function runJob(
    jobId: string,
    input: CreateJobInput,
    limit: number,
    ctl: JobControl,
    adopted?: Adoption,
  ): Promise<void> {
    try {
      let tasks: PlannedTask[];
      if (adopted?.tasks) {
        // Restart: the plan is already in the log, so nothing is planned or created again.
        tasks = adopted.tasks;
      } else {
        // An adopted Job without a saved plan is already running (see `adoptJob`).
        if (!adopted) transition(jobId, "running", "planning");
        const plan = await planJob(
          {
            planner: deps.planner,
            clock,
            appendEvent: append,
            planTimeoutMs: cfg.planTimeoutMs,
          },
          { jobId, goal: input.goal, initialPlan: input.initialPlan },
        );
        // Req 8.12: a cancelled Job starts nothing further, including the Tasks of a late plan.
        if (ctl.cancelled) return;
        if (!plan.ok) {
          // Req 7.3: no Task has been created or run.
          transition(jobId, "failed", plan.reason);
          return;
        }
        tasks = plan.tasks;
        for (const t of plan.tasks) {
          append({
            jobId,
            taskId: t.id,
            type: EVENT_TYPES.taskCreated,
            payload: {
              role: t.role,
              dependsOn: t.dependsOn,
              acceptanceChecks: t.acceptanceChecks,
              steps: t.steps,
              ...(t.title !== undefined ? { title: t.title } : {}),
              ...(t.instructions !== undefined ? { instructions: t.instructions } : {}),
              ...(t.requiresOutputFrom ? { requiresOutputFrom: t.requiresOutputFrom } : {}),
            },
          });
        }
      }

      const run: JobRun = {
        jobId,
        tasks,
        results: new Map(adopted?.results ?? []),
        usage: { ...(adopted?.usage ?? { tokens: 0, wallClockMs: 0, toolCalls: 0 }) },
        ctl,
        waiting: new Set(),
        loops: new Map(),
        completedSteps: new Map(adopted?.completedSteps ?? []),
        ...(adopted ? { adopted } : {}),
      };
      runs.set(jobId, run);
      const { failed, skipped, deniedSkipped } = await executePlan(run, limit);
      // `cancelJob` owns the final state of a cancelled Job.
      if (ctl.cancelled) return;
      if (failed.length === 0 && skipped.length === 0) {
        // The table has no running -> done edge; every Task is already verified or skipped by Sir.
        if (jobStateOf(jobId) !== "verifying") transition(jobId, "verifying", "all tasks verified");
        transition(
          jobId,
          "done",
          deniedSkipped.length > 0
            ? `all tasks done; skipped after denied approval: ${deniedSkipped.join(", ")}`
            : "all tasks done",
        );
      } else {
        const parts = [`task failed: ${failed.join(", ")}`];
        if (skipped.length > 0) parts.push(`not started: ${skipped.join(", ")}`);
        transition(jobId, "failed", parts.join("; "));
      }
    } catch (error) {
      if (ctl.cancelled) return;
      log.error(`job ${jobId} errored: ${errorMessage(error)}`);
      try {
        transition(jobId, "failed", `orchestrator error: ${errorMessage(error)}`);
      } catch {
        // Already terminal, or the log is failing.
      }
    }
  }

  // ------------------------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------------------------

  function getJob(jobId: string): JobView | undefined {
    const events = loadEvents(deps.db, jobId);
    const job = projectJobState(events).jobs[jobId];
    if (!job) return undefined;

    const results = new Map<string, string>();
    const attempts = new Map<string, number>();
    for (const e of events) {
      if (e.taskId === undefined) continue;
      if (e.type === EVENT_TYPES.stepCompleted && isRecord(e.payload)) {
        if (typeof e.payload.result === "string") results.set(e.taskId, e.payload.result);
      } else if (e.type === ORCHESTRATOR_EVENT_TYPES.verificationResult) {
        attempts.set(e.taskId, (attempts.get(e.taskId) ?? 0) + 1);
      }
    }

    const tasks: TaskView[] = Object.values(job.tasks).map((t) => ({
      id: t.id,
      ...(t.role !== undefined ? { role: t.role } : {}),
      dependsOn: t.dependsOn,
      state: t.state,
      ...(t.stateReason !== undefined ? { stateReason: t.stateReason } : {}),
      ...(results.has(t.id) ? { result: results.get(t.id) as string } : {}),
      verificationAttempts: attempts.get(t.id) ?? 0,
      usage: t.usage,
    }));
    return {
      id: job.id,
      ...(job.goal !== undefined ? { goal: job.goal } : {}),
      ...(job.type !== undefined ? { type: job.type } : {}),
      state: job.state,
      ...(job.stateReason !== undefined && (job.state === "failed" || job.state === "cancelled")
        ? { failureReason: job.stateReason }
        : {}),
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
      tasks,
    };
  }

  async function createJob(input: CreateJobInput): Promise<{ id: string }> {
    if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
      throw new TypeError("goal must be a non-empty string");
    }
    const limit = input.concurrencyLimit ?? cfg.concurrencyLimit;
    assertConcurrency(limit);

    const id = `job-${newId()}`;
    append({
      jobId: id,
      type: EVENT_TYPES.jobCreated,
      payload: {
        goal: input.goal,
        concurrencyLimit: limit,
        ...(input.type !== undefined ? { type: input.type } : {}),
      },
    });
    const ctl = new JobControl();
    controls.set(id, ctl);
    // runJob never rejects: it records its own failures against the Job.
    const run = runJob(id, input, limit, ctl).finally(() => {
      active.delete(id);
      controls.delete(id);
      runs.delete(id);
    });
    active.set(id, run);
    return { id };
  }

  async function awaitTerminal(jobId: string, signal?: AbortSignal): Promise<JobView> {
    signal?.throwIfAborted();
    const run = active.get(jobId);
    if (run) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        run.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
      });
    }
    const view = getJob(jobId);
    if (!view) throw new Error(`unknown job ${jobId}`);
    if (!TERMINAL_JOB_STATES.includes(view.state)) {
      throw new Error(`job ${jobId} is ${view.state} and is not running in this process`);
    }
    return view;
  }

  // ------------------------------------------------------------------------------------
  // Approvals and Job controls (Requirement 8)
  // ------------------------------------------------------------------------------------

  function decideApproval(
    jobId: string,
    taskId: string,
    decision: "approve" | "deny",
    channel: string,
  ): ApprovalDecisionResult {
    if (decision !== "approve" && decision !== "deny") {
      return { ok: false, error: "invalid-decision" };
    }
    if (getJob(jobId)?.tasks.some((t) => t.id === taskId) !== true) {
      return { ok: false, error: "unknown-task" };
    }
    return approvals.decide(jobId, taskId, decision, channel);
  }

  /** Moves the Job through the state table; a refusal throws `JobControlError`. */
  function moveJob(jobId: string, to: JobState, reason: string): void {
    const res = requestTransition(deps.db, jobId, to, { reason, nowMs: clock.now() });
    if (res.ok) return;
    const e = res.error;
    if (e.kind === "not-found") throw new JobControlError("not-found", `unknown job ${jobId}`);
    if (e.kind === "not-allowed") {
      throw new JobControlError(
        "not-allowed",
        `job ${jobId} is ${e.from} and cannot move to ${to}`,
        e.from,
      );
    }
    throw new JobControlError("write-failed", e.message);
  }

  /** The in-process control of a Job, or a `JobControlError` saying why there is none. */
  function activeControl(jobId: string): JobControl {
    const ctl = controls.get(jobId);
    if (ctl) return ctl;
    throw getJob(jobId)
      ? new JobControlError("not-active", `job ${jobId} is not running in this process`)
      : new JobControlError("not-found", `unknown job ${jobId}`);
  }

  function pauseJob(jobId: string): void {
    const ctl = activeControl(jobId);
    if (ctl.cancelled) throw new JobControlError("not-allowed", `job ${jobId} is being cancelled`);
    moveJob(jobId, "paused", "paused by user");
    // Same turn of the event loop: no Step can start between the state change and the gate.
    ctl.pause();
  }

  function resumeJob(jobId: string): void {
    const ctl = activeControl(jobId);
    if (ctl.cancelled) throw new JobControlError("not-allowed", `job ${jobId} is being cancelled`);
    moveJob(jobId, "running", "resumed by user");
    ctl.resume();
  }

  /** Waits for `work`, but no longer than `ms` on the injected clock. */
  function settleWithin(work: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancelTimer = clock.setTimer(resolve, ms);
      const done = () => {
        cancelTimer();
        resolve();
      };
      void work.then(done, done);
    });
  }

  async function cancelJob(jobId: string, reason = "cancelled by user"): Promise<void> {
    const before = getJob(jobId);
    if (!before) throw new JobControlError("not-found", `unknown job ${jobId}`);
    if (TERMINAL_JOB_STATES.includes(before.state)) {
      throw new JobControlError(
        "not-allowed",
        `job ${jobId} is already ${before.state}`,
        before.state,
      );
    }
    // Synchronous part: nothing new starts, running Steps are told to stop, and every pending
    // approval is dropped so its withheld action can never run (Req 8.12, 8.13).
    controls.get(jobId)?.cancel();
    approvals.discardJob(jobId, reason);

    const running = active.get(jobId);
    if (running) await settleWithin(running, CANCEL_SETTLE_MS);

    // Whatever has not stopped by now is released anyway, so the Job is cancelled in time.
    const job = projectJobState(loadEvents(deps.db, jobId)).jobs[jobId];
    for (const step of Object.values(job?.steps ?? {})) {
      if (step.status !== "running") continue;
      append({
        jobId,
        ...(step.taskId !== undefined ? { taskId: step.taskId } : {}),
        stepId: step.id,
        type: EVENT_TYPES.stepFailed,
        payload: { reason: "cancelled", cause: "cancelled" },
      });
    }
    for (const t of Object.values(job?.tasks ?? {})) {
      if (!FINISHED_TASK_STATES.includes(t.state)) setTaskState(jobId, t.id, "cancelled", reason);
    }
    moveJob(jobId, "cancelled", reason);
  }

  // ------------------------------------------------------------------------------------
  // Restart recovery (Requirement 13.10)
  // ------------------------------------------------------------------------------------

  async function adoptJob(jobId: string): Promise<AdoptJobResult> {
    if (active.has(jobId) || controls.has(jobId)) {
      return {
        ok: false,
        error: "already-active",
        reason: `job ${jobId} is already running in this process`,
      };
    }
    const adoption = buildAdoption(loadEvents(deps.db, jobId), jobId);
    if (!adoption) return { ok: false, error: "not-found", reason: `unknown job ${jobId}` };
    if (TERMINAL_JOB_STATES.includes(adoption.state)) {
      return { ok: false, error: "terminal", reason: `job ${jobId} is already ${adoption.state}` };
    }
    // A paused Job is held on purpose, and approvals do not survive a restart.
    if (adoption.state === "paused" || adoption.state === "waiting_approval") {
      return {
        ok: false,
        error: "not-resumable",
        reason: `job ${jobId} is ${adoption.state} and is not resumed automatically`,
      };
    }
    if (adoption.planIncomplete) {
      // Only part of the Task graph reached the log, so there is nothing safe to continue.
      const reason = "interrupted while saving the plan; the Task graph is incomplete";
      if (adoption.state === "pending") transition(jobId, "running", "resumed after restart");
      transition(jobId, "failed", reason);
      return { ok: false, error: "not-resumable", reason };
    }

    const limit = isValidConcurrencyLimit(adoption.concurrencyLimit)
      ? adoption.concurrencyLimit
      : cfg.concurrencyLimit;
    // `verifying` goes back to running so the Job finishes through the normal path.
    if (adoption.state !== "running") transition(jobId, "running", "resumed after restart");
    // The process that held these Leases is gone, so release them now instead of at expiry.
    for (const step of adoption.orphanedSteps) {
      append({
        jobId,
        ...(step.taskId !== undefined ? { taskId: step.taskId } : {}),
        stepId: step.stepId,
        type: EVENT_TYPES.leaseReclaimed,
        payload: { reason: "adopted after restart" },
      });
    }

    const replanned = adoption.tasks === null;
    const resumedTaskIds = (adoption.tasks ?? [])
      .filter((t) => !FINISHED_TASK_STATES.includes(adoption.taskStates[t.id] ?? "pending"))
      .map((t) => t.id);
    const completedStepIds = [...adoption.completedSteps.keys()];
    append({
      jobId,
      type: ORCHESTRATOR_EVENT_TYPES.jobAdopted,
      payload: { replanned, resumedTaskIds, completedStepIds },
    });

    const ctl = new JobControl();
    controls.set(jobId, ctl);
    // runJob never rejects: it records its own failures against the Job.
    const run = runJob(jobId, { goal: adoption.goal }, limit, ctl, adoption).finally(() => {
      active.delete(jobId);
      controls.delete(jobId);
      runs.delete(jobId);
    });
    active.set(jobId, run);
    return { ok: true, jobId, replanned, resumedTaskIds, completedStepIds };
  }

  return {
    adoptJob,
    createJob,
    awaitTerminal,
    getJob,
    decideApproval,
    pauseJob,
    resumeJob,
    cancelJob,
  };
}
