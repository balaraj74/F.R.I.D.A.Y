// Approvals and Job controls in the Orchestrator (Requirement 8.1, 8.2, 8.6-8.8, 8.10-8.13).
// Agents, notifier, clock and file system are fakes; no model or network is used.
import { describe, expect, it } from "vitest";

import type { ApprovalDeliveryReport, ApprovalRequest } from "../ops/notifier.js";
import { FakeClock, MemoryFs, flushMicrotasks } from "../runner/test-helpers.js";
import { loadEvents, openEventLog, projectJobState, type AppendedEvent } from "../store/index.js";
import { createOrchestrator } from "./runtime.js";
import {
  JobControlError,
  type AgentFactory,
  type AgentInstance,
  type AgentSpec,
  type ApprovalNotifier,
  type OrchestratedTurnRequest,
  type PreActionHook,
} from "./runtime-types.js";
import type { AcceptanceCheck } from "./types.js";

const fileCheck: AcceptanceCheck = { type: "file_exists", path: "out.txt" };
type RawTask = Record<string, unknown>;
const task = (id: string, dependsOn: string[] = [], extra: RawTask = {}): RawTask => ({
  id,
  role: "builder",
  dependsOn,
  acceptanceChecks: [fileCheck],
  ...extra,
});

type Turn = (req: OrchestratedTurnRequest) => Promise<{ reply: string }>;
const never: Turn = () => new Promise(() => undefined);
const PUSH = { command: "git push origin main" };

class FakeAgents implements AgentFactory {
  turns = new Map<string, Turn>();
  started: string[] = [];
  private count = 0;
  create(spec: AgentSpec): AgentInstance {
    return {
      id: `agent-${++this.count}`,
      sessionKey: spec.sessionKey,
      runTurn: (req) => {
        this.started.push(`${req.task.id}.${req.round}.${req.step.index}`);
        return (this.turns.get(req.task.id) ?? (async () => ({ reply: `done ${req.task.id}` })))(
          req,
        );
      },
    };
  }
}

class FakeNotifier implements ApprovalNotifier {
  requests: ApprovalRequest[] = [];
  applied: Array<[string, string]> = [];
  /** When set, `requestApproval` rejects with it. */
  failWith?: Error;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDeliveryReport> {
    this.requests.push(req);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      jobId: req.jobId,
      taskId: req.taskId,
      results: [],
      anyDelivered: true,
    });
  }
  decisionApplied(jobId: string, taskId: string): boolean {
    this.applied.push([jobId, taskId]);
    return true;
  }
}

function setup(opts: { concurrencyLimit?: number; preAction?: PreActionHook } = {}) {
  const db = openEventLog(":memory:");
  const clock = new FakeClock();
  const agents = new FakeAgents();
  const notifier = new FakeNotifier();
  const invoked: string[] = [];
  let ids = 0;
  const orch = createOrchestrator({
    db,
    planner: async () => {
      throw new Error("planner should not be called");
    },
    agents,
    collectEvidence: async () => ({ type: "file_exists", exists: true }),
    invokeTool: async (a) => {
      const command = (a.args as { command?: string } | undefined)?.command;
      invoked.push(command ?? a.tool);
      return "ok";
    },
    notifier,
    ...(opts.preAction ? { preAction: opts.preAction } : {}),
    clock,
    fs: new MemoryFs(),
    sleep: async () => undefined,
    newId: () => `id${++ids}`,
    config: {
      progressDir: "/progress",
      models: ["m1"],
      ...(opts.concurrencyLimit !== undefined ? { concurrencyLimit: opts.concurrencyLimit } : {}),
    },
  });
  const events = (jobId: string): AppendedEvent[] => loadEvents(db, jobId);
  const ofType = (jobId: string, type: string) => events(jobId).filter((e) => e.type === type);
  const start = async (tasks: RawTask[]) =>
    (await orch.createJob({ goal: "g", initialPlan: { tasks } })).id;
  const taskState = (jobId: string, taskId: string) =>
    orch.getJob(jobId)?.tasks.find((x) => x.id === taskId)?.state;
  const jobState = (jobId: string) => orch.getJob(jobId)?.state;
  const finish = (jobId: string) => clock.drive(orch.awaitTerminal(jobId));
  return {
    db,
    clock,
    agents,
    notifier,
    invoked,
    orch,
    events,
    ofType,
    start,
    taskState,
    jobState,
    finish,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flushMicrotasks();
  expect(cond()).toBe(true);
}

/** A turn that asks the gate to run `git push`, recording what the agent got back. */
function pushingTurn(results: unknown[]): Turn {
  return async (req) => {
    results.push(await req.gate.call("exec", PUSH));
    return { reply: "pushed" };
  };
}

describe("withholding a Never_Auto_Action (Req 8.1, 8.2)", () => {
  it("moves only the affected Task to waiting_approval while independent Tasks keep running and dependents wait", async () => {
    const t = setup();
    const results: unknown[] = [];
    let releaseB!: () => void;
    t.agents.turns.set("a", pushingTurn(results));
    t.agents.turns.set(
      "b",
      () => new Promise((resolve) => (releaseB = () => resolve({ reply: "b done" }))),
    );
    const id = await t.start([task("a"), task("b"), task("c", ["a"]), task("d", ["b"])]);

    await until(() => t.taskState(id, "a") === "waiting_approval");
    expect(t.taskState(id, "b")).toBe("running");
    expect(t.taskState(id, "c")).toBe("pending");
    expect(t.jobState(id)).toBe("running");
    expect(t.invoked).toEqual([]);
    expect(t.notifier.requests).toEqual([
      expect.objectContaining({ jobId: id, taskId: "a", action: "git push origin main" }),
    ]);
    expect(t.ofType(id, "approval-requested")[0]?.payload).toMatchObject({
      kind: "git push",
      previousState: "running",
    });

    // The independent chain finishes while "a" is still waiting.
    releaseB();
    await until(() => t.taskState(id, "d") === "done");
    expect(t.taskState(id, "a")).toBe("waiting_approval");
    expect(t.taskState(id, "c")).toBe("pending");
    expect(t.agents.started.some((s) => s.startsWith("c."))).toBe(false);

    expect(t.orch.decideApproval(id, "a", "approve", "whatsapp")).toEqual({
      ok: true,
      applied: true,
      decision: "approve",
      outcome: "resumed",
    });
    const view = await t.finish(id);
    expect(view.state).toBe("done");
    expect(view.tasks.map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    expect(t.invoked).toEqual(["git push origin main"]);
    expect(results).toEqual([{ ok: true, value: "ok" }]);
  });

  it("does not let a waiting Task hold a concurrency slot", async () => {
    const t = setup({ concurrencyLimit: 1 });
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a"), task("b")]);

    await until(() => t.taskState(id, "a") === "waiting_approval");
    await until(() => t.taskState(id, "b") === "done");
    t.orch.decideApproval(id, "a", "approve", "hud");
    expect((await t.finish(id)).state).toBe("done");
  });

  it("performs the withheld action as soon as it is approved, with no waiting on the clock (Req 8.7)", async () => {
    const t = setup();
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");

    const before = t.clock.now();
    t.orch.decideApproval(id, "a", "approve", "hud");
    await until(() => t.invoked.length === 1);
    expect(t.clock.now() - before).toBeLessThanOrEqual(5_000);
    expect(t.ofType(id, "approval-decision")[0]?.payload).toMatchObject({
      decision: "approve",
      channel: "hud",
    });
    // Reminders stop the moment the decision is applied.
    expect(t.notifier.applied).toEqual([[id, "a"]]);
    await t.finish(id);
  });

  it("returns Task to verifying when the withheld action came from the Verifier", async () => {
    const t = setup();
    const orch = createOrchestrator({
      db: t.db,
      planner: async () => ({}),
      agents: t.agents,
      collectEvidence: async (ctx) => {
        const verdict = await ctx.gate.authorize("exec", PUSH);
        return { type: "file_exists", exists: verdict.allowed };
      },
      notifier: t.notifier,
      clock: t.clock,
      fs: new MemoryFs(),
      config: { progressDir: "/p", models: ["m1"] },
    });
    const { id } = await orch.createJob({ goal: "g", initialPlan: { tasks: [task("a")] } });
    const state = () => orch.getJob(id)?.tasks[0]?.state;
    await until(() => state() === "waiting_approval");
    expect(t.ofType(id, "approval-requested")[0]?.payload).toMatchObject({
      previousState: "verifying",
    });
    orch.decideApproval(id, "a", "approve", "hud");
    const view = await t.clock.drive(orch.awaitTerminal(id));
    expect(view.state).toBe("done");
  });

  it("leaves actions that are not Never_Auto_Actions alone and sends no approval request (Req 8.3)", async () => {
    const t = setup();
    const results: unknown[] = [];
    t.agents.turns.set("a", async (req) => {
      results.push(await req.gate.call("exec", { command: "git status" }));
      results.push(await req.gate.call("read", { path: "x" }));
      return { reply: "ok" };
    });
    const id = await t.start([task("a")]);
    expect((await t.finish(id)).state).toBe("done");
    expect(t.invoked).toEqual(["git status", "read"]);
    expect(t.notifier.requests).toEqual([]);
    expect(t.ofType(id, "approval-requested")).toEqual([]);
  });

  it("still runs the configured preAction hook after an approval", async () => {
    const t = setup({ preAction: () => ({ allow: false, reason: "outside worktree" }) });
    const results: unknown[] = [];
    t.agents.turns.set("a", pushingTurn(results));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");
    t.orch.decideApproval(id, "a", "approve", "hud");
    await t.finish(id);
    expect(results).toEqual([{ ok: false, error: 'tool "exec" blocked: outside worktree' }]);
    expect(t.invoked).toEqual([]);
  });

  it("keeps the Task waiting and actionable when the Notifier fails", async () => {
    const t = setup();
    t.notifier.failWith = new Error("hud down");
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a")]);
    await until(() => t.ofType(id, "approval-notify-failed").length === 1);
    expect(t.taskState(id, "a")).toBe("waiting_approval");
    expect(t.orch.decideApproval(id, "a", "approve", "whatsapp")).toMatchObject({ applied: true });
    expect((await t.finish(id)).state).toBe("done");
  });

  it("works without a Notifier configured", async () => {
    const t = setup();
    const orch = createOrchestrator({
      db: t.db,
      planner: async () => ({}),
      agents: t.agents,
      collectEvidence: async () => ({ type: "file_exists", exists: true }),
      clock: t.clock,
      fs: new MemoryFs(),
      config: { progressDir: "/p", models: ["m1"] },
    });
    t.agents.turns.set("a", pushingTurn([]));
    const { id } = await orch.createJob({ goal: "g", initialPlan: { tasks: [task("a")] } });
    await until(() => orch.getJob(id)?.tasks[0]?.state === "waiting_approval");
    expect(orch.decideApproval(id, "a", "deny", "hud")).toMatchObject({ applied: true });
  });
});

describe("first decision wins (Req 8.6)", () => {
  it("applies approve, ignores a later deny, and records both without changing the Task", async () => {
    const t = setup();
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");

    // Both arrive in the same tick with the same timestamp: input order decides.
    const first = t.orch.decideApproval(id, "a", "approve", "hud");
    const second = t.orch.decideApproval(id, "a", "deny", "whatsapp");

    expect(first).toMatchObject({ ok: true, applied: true, decision: "approve" });
    expect(second).toEqual({
      ok: true,
      applied: false,
      reason: "a decision was already applied",
    });
    const view = await t.finish(id);
    expect(view.state).toBe("done");
    expect(t.invoked).toEqual(["git push origin main"]);
    expect(t.ofType(id, "approval-decision")).toHaveLength(1);
    expect(t.ofType(id, "approval-decision-ignored")[0]?.payload).toMatchObject({
      decision: "deny",
      channel: "whatsapp",
      appliedDecision: "approve",
    });
    // The late decision did not touch the Task or notify again.
    expect(t.notifier.applied).toEqual([[id, "a"]]);
    // A decision after the Task has finished is ignored too.
    expect(t.orch.decideApproval(id, "a", "deny", "hud")).toMatchObject({ applied: false });
    expect(t.taskState(id, "a")).toBe("done");
  });

  it("keeps the denial when an approve arrives afterwards", async () => {
    const t = setup();
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");

    t.orch.decideApproval(id, "a", "deny", "whatsapp");
    expect(t.orch.decideApproval(id, "a", "approve", "hud")).toMatchObject({ applied: false });
    await t.finish(id);
    expect(t.taskState(id, "a")).toBe("skipped");
    expect(t.invoked).toEqual([]);
  });

  it("rejects unknown Tasks and invalid decisions without recording anything", async () => {
    const t = setup();
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");
    const before = t.events(id).length;
    expect(t.orch.decideApproval(id, "nope", "approve", "hud")).toEqual({
      ok: false,
      error: "unknown-task",
    });
    expect(t.orch.decideApproval("job-missing", "a", "approve", "hud")).toEqual({
      ok: false,
      error: "unknown-task",
    });
    expect(t.orch.decideApproval(id, "a", "maybe" as unknown as "approve", "hud")).toEqual({
      ok: false,
      error: "invalid-decision",
    });
    expect(t.events(id)).toHaveLength(before);
    t.orch.decideApproval(id, "a", "approve", "hud");
    await t.finish(id);
  });
});

describe("denying an approval (Req 8.8)", () => {
  it("marks the Task skipped when no dependent needs its output, lets dependents run, and never performs the action", async () => {
    const t = setup();
    const results: unknown[] = [];
    t.agents.turns.set("a", pushingTurn(results));
    const id = await t.start([task("a"), task("c", ["a"])]);
    await until(() => t.taskState(id, "a") === "waiting_approval");

    const decision = t.orch.decideApproval(id, "a", "deny", "hud");
    expect(decision).toMatchObject({
      ok: true,
      applied: true,
      decision: "deny",
      outcome: "skipped",
    });
    const view = await t.finish(id);

    expect(t.invoked).toEqual([]);
    expect(view.tasks.map((x) => [x.id, x.state])).toEqual([
      ["a", "skipped"],
      ["c", "done"],
    ]);
    expect(view.state).toBe("done");
    expect(view.tasks[0]?.stateReason).toContain("approval denied via hud: git push origin main");
    const outcome = t.ofType(id, "approval-outcome")[0]?.payload as Record<string, unknown>;
    expect(outcome).toMatchObject({ decision: "deny", outcome: "skipped" });
    expect(String(outcome.reason)).toContain("git push origin main");
    expect(t.notifier.applied).toEqual([[id, "a"]]);
    // The Task was stopped: it never reached verification.
    expect(t.ofType(id, "verification-started").map((e) => e.taskId)).toEqual(["c"]);
  });

  it("marks the Task failed when a dependent requires its output, and does not start the dependent", async () => {
    const t = setup();
    t.agents.turns.set("a", pushingTurn([]));
    const id = await t.start([
      task("a"),
      task("b", ["a"]),
      task("c", ["b"], { requiresOutputFrom: ["a"] }),
    ]);
    await until(() => t.taskState(id, "a") === "waiting_approval");

    expect(t.orch.decideApproval(id, "a", "deny", "whatsapp")).toMatchObject({
      outcome: "failed",
    });
    const view = await t.finish(id);

    expect(t.invoked).toEqual([]);
    expect(view.state).toBe("failed");
    expect(view.tasks.map((x) => [x.id, x.state])).toEqual([
      ["a", "failed"],
      ["b", "skipped"],
      ["c", "skipped"],
    ]);
    expect(t.agents.started.some((s) => /^[bc]\./.test(s))).toBe(false);
    expect(t.ofType(id, "approval-outcome")[0]?.payload).toMatchObject({
      decision: "deny",
      outcome: "failed",
    });
    const changed = t
      .ofType(id, "task-state-changed")
      .filter((e) => e.taskId === "a")
      .map((e) => e.payload as { to: string; reason?: string; outcome?: string });
    expect(changed.at(-1)).toMatchObject({ to: "failed", outcome: "failed" });
  });

  it("gives the agent an error for the denied call", async () => {
    const t = setup();
    const results: unknown[] = [];
    t.agents.turns.set("a", pushingTurn(results));
    const id = await t.start([task("a")]);
    await until(() => t.taskState(id, "a") === "waiting_approval");
    t.orch.decideApproval(id, "a", "deny", "hud");
    await t.finish(id);
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(String((results[0] as { error: string }).error)).toContain("denied");
  });
});

describe("pause and resume (Req 8.10, 8.11)", () => {
  it("starts no new Task after pause, lets the running Step finish, and starts ready Tasks on resume", async () => {
    const t = setup();
    let releaseA!: () => void;
    t.agents.turns.set(
      "a",
      () => new Promise((resolve) => (releaseA = () => resolve({ reply: "a done" }))),
    );
    const id = await t.start([task("a"), task("b", ["a"])]);
    await until(() => typeof releaseA === "function");

    t.orch.pauseJob(id);
    expect(t.jobState(id)).toBe("paused");

    // The running Step finishes and its result is recorded while paused.
    releaseA();
    await until(() => t.taskState(id, "a") === "done");
    expect(t.ofType(id, "step-completed")).toHaveLength(1);

    // Nothing starts within the 2s pause deadline, or well past it.
    await t.clock.advance(2_000);
    await t.clock.advance(60_000);
    expect(t.agents.started.some((s) => s.startsWith("b."))).toBe(false);
    expect(t.taskState(id, "b")).toBe("pending");
    expect(t.jobState(id)).toBe("paused");

    const resumedAt = t.clock.now();
    t.orch.resumeJob(id);
    expect(t.jobState(id)).toBe("running");
    await until(() => t.agents.started.some((s) => s.startsWith("b.")));
    expect(t.clock.now() - resumedAt).toBeLessThanOrEqual(5_000);
    const view = await t.finish(id);
    expect(view.state).toBe("done");
    const states = t.ofType(id, "job-state-changed").map((e) => (e.payload as { to: string }).to);
    expect(states).toEqual(["running", "paused", "running", "verifying", "done"]);
  });

  it("does not start the next Step of a Task while paused", async () => {
    const t = setup();
    let releaseFirst!: () => void;
    let calls = 0;
    t.agents.turns.set("a", () => {
      calls += 1;
      return calls === 1
        ? new Promise((resolve) => (releaseFirst = () => resolve({ reply: "step 1" })))
        : Promise.resolve({ reply: "step 2" });
    });
    // 100,000 expected reply tokens split into two Steps.
    const id = await t.start([task("a", [], { estimatedReplyTokens: 100_000 })]);
    await until(() => typeof releaseFirst === "function");

    t.orch.pauseJob(id);
    releaseFirst();
    await until(() => t.ofType(id, "step-completed").length === 1);
    await t.clock.advance(10_000);
    expect(calls).toBe(1);

    t.orch.resumeJob(id);
    await until(() => calls === 2);
    expect((await t.finish(id)).state).toBe("done");
  });

  it("holds the Job paused when every Task finished during the pause, then completes on resume", async () => {
    const t = setup();
    let releaseA!: () => void;
    t.agents.turns.set(
      "a",
      () => new Promise((resolve) => (releaseA = () => resolve({ reply: "ok" }))),
    );
    const id = await t.start([task("a")]);
    await until(() => typeof releaseA === "function");
    t.orch.pauseJob(id);
    releaseA();
    await until(() => t.taskState(id, "a") === "done");
    await t.clock.advance(5_000);
    expect(t.jobState(id)).toBe("paused");
    t.orch.resumeJob(id);
    expect((await t.finish(id)).state).toBe("done");
  });

  it("refuses to pause or resume in the wrong state or for an unknown Job", async () => {
    const t = setup();
    t.agents.turns.set("a", never);
    const id = await t.start([task("a")]);
    await until(() => t.agents.started.length === 1);

    expect(() => t.orch.resumeJob(id)).toThrow(JobControlError);
    t.orch.pauseJob(id);
    expect(() => t.orch.pauseJob(id)).toThrow(/cannot move to paused/);
    expect(() => t.orch.pauseJob("job-missing")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
    await t.orch.cancelJob(id);
  });
});

describe("cancel (Req 8.12, 8.13)", () => {
  it("discards the pending approval, cancels the Tasks, releases Leases and never performs the action", async () => {
    const t = setup();
    const results: unknown[] = [];
    t.agents.turns.set("a", pushingTurn(results));
    t.agents.turns.set("b", never);
    const id = await t.start([task("a"), task("b"), task("c", ["a"])]);
    await until(() => t.taskState(id, "a") === "waiting_approval");
    await until(() => t.taskState(id, "b") === "running");
    const startedBefore = [...t.agents.started];
    const cancelledAt = t.clock.now();

    await t.clock.drive(t.orch.cancelJob(id));

    expect(t.clock.now() - cancelledAt).toBeLessThanOrEqual(30_000);
    const view = t.orch.getJob(id);
    expect(view?.state).toBe("cancelled");
    expect(view?.tasks.map((x) => [x.id, x.state])).toEqual([
      ["a", "cancelled"],
      ["b", "cancelled"],
      ["c", "cancelled"],
    ]);
    expect(t.invoked).toEqual([]);
    expect(t.ofType(id, "approval-discarded")).toHaveLength(1);
    expect(t.notifier.applied).toEqual([[id, "a"]]);

    // The running Step was stopped and its Lease released.
    const job = projectJobState(t.events(id)).jobs[id];
    const steps = Object.values(job?.steps ?? {});
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status !== "running" && s.lease === undefined)).toBe(true);

    // Nothing further starts, and the withheld call returned an error to the agent.
    await t.clock.advance(120_000);
    expect(t.agents.started).toEqual(startedBefore);
    expect(results).toEqual([{ ok: false, error: expect.stringContaining("cancelled by user") }]);
    expect(t.invoked).toEqual([]);
    expect(t.orch.getJob(id)?.state).toBe("cancelled");

    // A decision that arrives after the cancel changes nothing.
    expect(t.orch.decideApproval(id, "a", "approve", "hud")).toMatchObject({ applied: false });
    expect(t.taskState(id, "a")).toBe("cancelled");
    expect(t.invoked).toEqual([]);
    expect((await t.orch.awaitTerminal(id)).state).toBe("cancelled");
  });

  it("cancels a paused Job and a Job whose Step ignores the stop request", async () => {
    const t = setup();
    t.agents.turns.set("a", never);
    const id = await t.start([task("a"), task("b", ["a"])]);
    await until(() => t.agents.started.length === 1);
    t.orch.pauseJob(id);
    await t.clock.drive(t.orch.cancelJob(id, "no longer needed"));
    const view = t.orch.getJob(id);
    expect(view).toMatchObject({ state: "cancelled", failureReason: "no longer needed" });
    expect(view?.tasks.map((x) => x.state)).toEqual(["cancelled", "cancelled"]);
    expect(t.agents.started).toHaveLength(1);
  });

  it("stops a Job that is still planning, and starts none of its Tasks when the plan arrives late", async () => {
    const db = openEventLog(":memory:");
    const clock = new FakeClock();
    const agents = new FakeAgents();
    let deliver!: (plan: unknown) => void;
    const orch = createOrchestrator({
      db,
      planner: () => new Promise((resolve) => (deliver = resolve)),
      agents,
      collectEvidence: async () => ({ type: "file_exists", exists: true }),
      clock,
      fs: new MemoryFs(),
      config: { progressDir: "/p", models: ["m1"] },
    });
    const { id } = await orch.createJob({ goal: "g" });
    await until(() => typeof deliver === "function");

    const cancelled = orch.cancelJob(id);
    deliver({ tasks: [task("a")] });
    await clock.drive(cancelled);

    expect(orch.getJob(id)?.state).toBe("cancelled");
    expect(orch.getJob(id)?.tasks).toEqual([]);
    expect(agents.started).toEqual([]);
    expect(loadEvents(db, id).some((e) => e.type === "task-created")).toBe(false);
  });

  it("cancels within 30s even when the Job cannot wind down", async () => {
    const db = openEventLog(":memory:");
    const clock = new FakeClock();
    const orch = createOrchestrator({
      db,
      planner: () => new Promise(() => undefined),
      agents: new FakeAgents(),
      collectEvidence: async () => ({ type: "file_exists", exists: true }),
      clock,
      fs: new MemoryFs(),
      config: { progressDir: "/p", models: ["m1"], planTimeoutMs: 3_600_000 },
    });
    const { id } = await orch.createJob({ goal: "g" });
    const startedAt = clock.now();
    await clock.drive(orch.cancelJob(id));
    expect(orch.getJob(id)?.state).toBe("cancelled");
    expect(clock.now() - startedAt).toBeLessThanOrEqual(30_000);
  });

  it("rejects cancelling an unknown or finished Job", async () => {
    const t = setup();
    const id = await t.start([task("a")]);
    await t.finish(id);
    await expect(t.orch.cancelJob(id)).rejects.toMatchObject({ code: "not-allowed" });
    await expect(t.orch.cancelJob("job-missing")).rejects.toMatchObject({ code: "not-found" });
    expect(t.orch.getJob(id)?.state).toBe("done");
  });
});
