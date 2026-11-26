// Orchestrator runtime tests (Requirement 7). Everything external is a fake: agents, planner,
// evidence collector, clock and file system. No model calls are made.
import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFs, flushMicrotasks } from "../runner/test-helpers.js";
import { loadEvents, openEventLog, type AppendedEvent } from "../store/index.js";
import { createOrchestrator } from "./runtime.js";
import type {
  AgentFactory,
  AgentInstance,
  AgentSpec,
  EvidenceCollector,
  OrchestratedTurnRequest,
  PlanRequest,
  PlannerAgent,
} from "./runtime-types.js";
import { MAX_PLAN_CORRECTIONS } from "./planner.js";
import type { AcceptanceCheck, Evidence } from "./types.js";

type RawTask = {
  id: string;
  role: string;
  dependsOn: string[];
  acceptanceChecks: AcceptanceCheck[];
  estimatedReplyTokens?: number;
};

const fileCheck: AcceptanceCheck = { type: "file_exists", path: "out.txt" };
const task = (id: string, dependsOn: string[] = [], extra: Partial<RawTask> = {}): RawTask => ({
  id,
  role: "builder",
  dependsOn,
  acceptanceChecks: [fileCheck],
  ...extra,
});

function passEvidence(check: AcceptanceCheck): Evidence {
  switch (check.type) {
    case "tests_pass":
      return { type: "tests_pass", exitCode: 0 };
    case "file_exists":
      return { type: "file_exists", exists: true };
    case "exit_code":
      return { type: "exit_code", exitCode: check.expected };
    case "rubric":
      return { type: "rubric", metItems: check.items };
  }
}

class FakeAgents implements AgentFactory {
  created: AgentSpec[] = [];
  instances = new Map<string, AgentInstance>();
  private count = 0;
  private byTask = new Map<string, AgentInstance>();
  /** Makes the factory hand the Task's own agent back as its Verifier. */
  reuseTaskAgentForVerifier = false;
  turn: (req: OrchestratedTurnRequest) => Promise<{ reply: string }> = async (req) => ({
    reply: `result of ${req.task.id}`,
  });
  turns: OrchestratedTurnRequest[] = [];

  create(spec: AgentSpec): AgentInstance {
    this.created.push(spec);
    if (spec.purpose === "verifier" && this.reuseTaskAgentForVerifier) {
      return this.byTask.get(spec.taskId) as AgentInstance;
    }
    const instance: AgentInstance = {
      id: `agent-${++this.count}`,
      sessionKey: spec.sessionKey,
      runTurn: (req) => {
        this.turns.push(req);
        return this.turn(req);
      },
    };
    this.instances.set(instance.id, instance);
    if (spec.purpose === "task") this.byTask.set(spec.taskId, instance);
    return instance;
  }
}

function setup(
  opts: {
    planner?: PlannerAgent;
    collect?: EvidenceCollector;
    concurrencyLimit?: number;
    models?: string[];
  } = {},
) {
  const db = openEventLog(":memory:");
  const clock = new FakeClock();
  const fs = new MemoryFs();
  const agents = new FakeAgents();
  const planCalls: PlanRequest[] = [];
  const evidenceCalls: Array<{ taskId: string; verifierId: string; verifierKey: string }> = [];
  let ids = 0;
  const planner: PlannerAgent =
    opts.planner ??
    (async () => {
      throw new Error("planner should not be called");
    });
  const collectEvidence: EvidenceCollector =
    opts.collect ??
    (async (ctx) => {
      evidenceCalls.push({
        taskId: ctx.taskId,
        verifierId: ctx.verifier.id,
        verifierKey: ctx.verifier.sessionKey,
      });
      return passEvidence(ctx.check);
    });
  const orch = createOrchestrator({
    db,
    planner: async (req) => {
      planCalls.push(req);
      return planner(req);
    },
    agents,
    collectEvidence,
    clock,
    fs,
    sleep: async () => undefined,
    newId: () => `id${++ids}`,
    config: {
      progressDir: "/progress",
      ...(opts.concurrencyLimit !== undefined ? { concurrencyLimit: opts.concurrencyLimit } : {}),
      models: opts.models ?? ["m1"],
    },
  });
  const events = (jobId: string): AppendedEvent[] => loadEvents(db, jobId);
  const ofType = (jobId: string, type: string) => events(jobId).filter((e) => e.type === type);
  const run = async (plan: unknown) => {
    const { id } = await orch.createJob({ goal: "ship it", initialPlan: plan });
    const view = await clock.drive(orch.awaitTerminal(id));
    return { id, view };
  };
  return { db, clock, fs, agents, orch, planCalls, evidenceCalls, events, ofType, run };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flushMicrotasks();
  expect(cond()).toBe(true);
}

describe("Planner: validation and corrections (Req 7.2, 7.3, 7.4)", () => {
  it("fails the Job after the initial plan and 3 corrections are all invalid, and runs no Task", async () => {
    const t = setup({ planner: async () => ({ tasks: [task("a", ["a"])] }) });
    const { id } = await t.orch.createJob({ goal: "g" });
    const view = await t.clock.drive(t.orch.awaitTerminal(id));

    expect(MAX_PLAN_CORRECTIONS).toBe(3);
    expect(t.planCalls).toHaveLength(1 + MAX_PLAN_CORRECTIONS);
    expect(view.state).toBe("failed");
    expect(view.failureReason).toContain("plan validation failed");
    expect(view.failureReason).toContain("task a: depends on itself");
    expect(view.tasks).toEqual([]);
    expect(t.agents.created).toEqual([]);
    expect(t.ofType(id, "plan-rejected")).toHaveLength(4);
    expect(t.ofType(id, "task-created")).toHaveLength(0);
    expect(t.ofType(id, "step-started")).toHaveLength(0);
  });

  it("sends the recorded validation errors back with each correction request", async () => {
    const t = setup({ planner: async () => ({ tasks: [] }) });
    const { id } = await t.orch.createJob({ goal: "g" });
    await t.clock.drive(t.orch.awaitTerminal(id));

    expect(t.planCalls.map((c) => c.attempt)).toEqual([1, 2, 3, 4]);
    expect(t.planCalls[0]?.previousErrors).toEqual([]);
    expect(t.planCalls[1]?.previousErrors[0]).toContain("1-50 tasks");
    const rejected = t.ofType(id, "plan-rejected")[0]?.payload as { errors: string[] };
    expect(rejected.errors[0]).toContain("1-50 tasks");
  });

  it("names the offending Task ids for cycles and unknown dependencies", async () => {
    const t = setup({
      planner: async () => ({
        tasks: [task("a", ["b"]), task("b", ["a"]), task("c", ["ghost"])],
      }),
    });
    const { id } = await t.orch.createJob({ goal: "g" });
    const view = await t.clock.drive(t.orch.awaitTerminal(id));
    const rejected = t.ofType(id, "plan-rejected")[0]?.payload as { errors: string[] };
    const errors = rejected.errors.join("\n");
    expect(errors).toContain("task a: part of a dependency cycle");
    expect(errors).toContain("task c: depends on unknown task ghost");
    expect(view.state).toBe("failed");
  });

  it("rejects malformed planner output (bad check, bad JSON) instead of throwing", async () => {
    const outputs: unknown[] = [
      "not json",
      {
        tasks: [{ id: "a", role: "builder", dependsOn: [], acceptanceChecks: [{ type: "nope" }] }],
      },
      { tasks: [{ id: "a", role: "wizard", dependsOn: [], acceptanceChecks: [fileCheck] }] },
      { tasks: [task("a", [], { estimatedReplyTokens: Number.POSITIVE_INFINITY })] },
    ];
    let i = 0;
    const t = setup({ planner: async () => outputs[i++] });
    const { id } = await t.orch.createJob({ goal: "g" });
    const view = await t.clock.drive(t.orch.awaitTerminal(id));
    expect(view.state).toBe("failed");
    const rejected = t
      .ofType(id, "plan-rejected")
      .map((e) => (e.payload as { errors: string[] }).errors.join(" "));
    expect(rejected[0]).toContain("not valid JSON");
    expect(rejected[1]).toContain("task a: acceptance check #1");
    expect(rejected[2]).toContain("task a: invalid role");
    expect(rejected[3]).toContain("task a: estimatedReplyTokens");
  });

  it("accepts a corrected plan and runs it", async () => {
    let calls = 0;
    const t = setup({
      planner: async () => (++calls < 3 ? { tasks: [] } : { tasks: [task("a")] }),
    });
    const { id } = await t.orch.createJob({ goal: "g" });
    const view = await t.clock.drive(t.orch.awaitTerminal(id));
    expect(calls).toBe(3);
    expect(view.state).toBe("done");
    expect(t.ofType(id, "plan-accepted")[0]?.payload).toEqual({ attempt: 3, taskCount: 1 });
  });

  it("counts a planner that does not answer within 60s as a rejected attempt", async () => {
    const t = setup({ planner: () => new Promise(() => undefined) });
    const { id } = await t.orch.createJob({ goal: "g" });
    const started = t.clock.now();
    const view = await t.clock.drive(t.orch.awaitTerminal(id));
    expect(view.state).toBe("failed");
    expect(t.planCalls).toHaveLength(4);
    expect(t.clock.now() - started).toBe(4 * 60_000);
    const first = t.ofType(id, "plan-rejected")[0]?.payload as { errors: string[] };
    expect(first.errors[0]).toContain("within 60s");
    expect(t.planCalls[0]?.signal.aborted).toBe(true);
  });

  it("persists the accepted plan as task-created events before any Step starts", async () => {
    const t = setup({ planner: async () => ({ tasks: [task("a"), task("b", ["a"])] }) });
    const { id } = await t.orch.createJob({ goal: "g" });
    await t.clock.drive(t.orch.awaitTerminal(id));
    const types = t.events(id).map((e) => e.type);
    expect(types.lastIndexOf("task-created")).toBeLessThan(types.indexOf("step-started"));
    const created = t.ofType(id, "task-created")[1]?.payload as {
      dependsOn: string[];
      role: string;
    };
    expect(created).toMatchObject({ role: "builder", dependsOn: ["a"] });
  });

  it("splits a large expected reply into Steps of at most 64,000 tokens (Req 6.5)", async () => {
    const t = setup();
    const { view } = await t.run({ tasks: [task("a", [], { estimatedReplyTokens: 150_000 })] });
    expect(view.state).toBe("done");
    const sizes = t.agents.turns.map((r) => r.step.expectedReplyTokens);
    expect(sizes).toHaveLength(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64_000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(150_000);
    expect(t.agents.turns.map((r) => r.step.count)).toEqual([3, 3, 3]);
  });
});

describe("Orchestrator: running Tasks (Req 7.6, 7.9)", () => {
  it("runs a dependency chain, passes upstream results, and finishes the Job done", async () => {
    const t = setup();
    const { id, view } = await t.run({ tasks: [task("a"), task("b", ["a"])] });
    expect(view.state).toBe("done");
    expect(view.tasks.map((x) => [x.id, x.state, x.result])).toEqual([
      ["a", "done", "result of a"],
      ["b", "done", "result of b"],
    ]);
    const bTurn = t.agents.turns.find((r) => r.task.id === "b");
    expect(bTurn?.input.upstream).toEqual([{ taskId: "a", result: "result of a" }]);
    expect(t.orch.getJob(id)?.state).toBe("done");
    const jobStates = t
      .ofType(id, "job-state-changed")
      .map((e) => (e.payload as { to: string }).to);
    expect(jobStates).toEqual(["running", "verifying", "done"]);
  });

  it("starts ready Tasks in parallel but never above the concurrency limit", async () => {
    const t = setup({ concurrencyLimit: 2 });
    let running = 0;
    let peak = 0;
    const gates = new Map<string, () => void>();
    t.agents.turn = (req) =>
      new Promise((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        gates.set(req.task.id, () => {
          running -= 1;
          resolve({ reply: `r-${req.task.id}` });
        });
      });

    const { id } = await t.orch.createJob({
      goal: "g",
      initialPlan: { tasks: ["a", "b", "c", "d", "e"].map((n) => task(n)) },
    });
    await until(() => gates.size === 2);
    expect([...gates.keys()].sort()).toEqual(["a", "b"]);

    // Finishing one Task frees a slot for the next ready Task.
    gates.get("a")?.();
    await until(() => gates.size === 3);
    expect(gates.has("c")).toBe(true);

    for (const name of ["b", "c", "d", "e"]) {
      await until(() => gates.has(name));
      gates.get(name)?.();
    }
    const view = await t.clock.drive(t.orch.awaitTerminal(id));
    expect(view.state).toBe("done");
    expect(peak).toBe(2);
  });

  it("uses the Job's own limit, and rejects a limit outside 1-16 before writing anything", async () => {
    const t = setup();
    for (const bad of [0, 17, 2.5, Number.NaN]) {
      await expect(t.orch.createJob({ goal: "g", concurrencyLimit: bad })).rejects.toThrow(
        RangeError,
      );
    }
    expect(loadEvents(t.db)).toEqual([]);
    expect(() => setup({ concurrencyLimit: 0 })).toThrow(RangeError);

    let running = 0;
    let peak = 0;
    t.agents.turn = async (req) => {
      running += 1;
      peak = Math.max(peak, running);
      await flushMicrotasks();
      running -= 1;
      return { reply: req.task.id };
    };
    const { id } = await t.orch.createJob({
      goal: "g",
      concurrencyLimit: 1,
      initialPlan: { tasks: [task("a"), task("b"), task("c")] },
    });
    expect((await t.clock.drive(t.orch.awaitTerminal(id))).state).toBe("done");
    expect(peak).toBe(1);
  });

  it("fails a Task whose Step fails and does not verify it", async () => {
    const t = setup();
    t.agents.turn = async () => {
      throw new Error("model exploded");
    };
    const { id, view } = await t.run({ tasks: [task("a"), task("b", ["a"])] });
    expect(view.state).toBe("failed");
    expect(view.tasks.map((x) => x.state)).toEqual(["failed", "skipped"]);
    expect(view.tasks[0]?.stateReason).toContain("step a.1.1 failed");
    expect(t.ofType(id, "verification-started")).toHaveLength(0);
  });
});

describe("Orchestrator: role allowlists (Req 7.5)", () => {
  it("denies a tool outside the Role's allowlist, records it against the Task and returns an error", async () => {
    const t = setup();
    const invoked: string[] = [];
    const db = t.db;
    const orch = createOrchestrator({
      db,
      planner: async () => ({}),
      agents: t.agents,
      collectEvidence: async (ctx) => passEvidence(ctx.check),
      clock: t.clock,
      fs: t.fs,
      invokeTool: async (a) => {
        invoked.push(a.tool);
        return "ok";
      },
      config: { progressDir: "/p", models: ["m1"] },
    });
    const seen: unknown[] = [];
    t.agents.turn = async (req) => {
      seen.push(await req.gate.call("write", { path: "x" }));
      seen.push(await req.gate.call("read", { path: "x" }));
      return { reply: "researched" };
    };
    const { id } = await orch.createJob({
      goal: "g",
      initialPlan: { tasks: [task("r", [], { role: "researcher" })] },
    });
    const view = await t.clock.drive(orch.awaitTerminal(id));

    expect(view.state).toBe("done");
    expect(seen[0]).toEqual({
      ok: false,
      error: 'tool "write" is not permitted for role "researcher"',
    });
    expect(seen[1]).toEqual({ ok: true, value: "ok" });
    expect(invoked).toEqual(["read"]);
    const denied = loadEvents(db, id).filter((e) => e.type === "tool-denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      taskId: "r",
      payload: { tool: "write", role: "researcher" },
    });
    expect(denied[0]?.stepId).toBe("r.1.1");
  });

  it("applies the same allowlist to the Verifier and runs the pre-action hook after it", async () => {
    const t = setup();
    const results: unknown[] = [];
    const orch = createOrchestrator({
      db: t.db,
      planner: async () => ({}),
      agents: t.agents,
      collectEvidence: async (ctx) => {
        results.push(await ctx.gate.authorize("write"));
        results.push(await ctx.gate.authorize("exec"));
        results.push(await ctx.gate.authorize("read"));
        return passEvidence(ctx.check);
      },
      preAction: (a) =>
        a.tool === "exec" ? { allow: false, reason: "needs approval" } : { allow: true },
      clock: t.clock,
      fs: t.fs,
      config: { progressDir: "/p", models: ["m1"] },
    });
    const { id } = await orch.createJob({ goal: "g", initialPlan: { tasks: [task("a")] } });
    await t.clock.drive(orch.awaitTerminal(id));
    expect(results).toEqual([
      { allowed: false, error: 'tool "write" is not permitted for role "verifier"' },
      { allowed: false, error: 'tool "exec" blocked: needs approval' },
      { allowed: true },
    ]);
    expect(loadEvents(t.db, id).filter((e) => e.type === "action-blocked")).toHaveLength(1);
  });
});

describe("Verifier: separate session and evidence (Req 7.8, 7.9)", () => {
  it("verifies in a fresh session on a different agent instance than the one that ran the Steps", async () => {
    const t = setup();
    const { id, view } = await t.run({ tasks: [task("a", [], { estimatedReplyTokens: 100_000 })] });
    expect(view.state).toBe("done");

    const taskSpec = t.agents.created.find((s) => s.purpose === "task");
    const verifierSpec = t.agents.created.find((s) => s.purpose === "verifier");
    expect(verifierSpec?.role).toBe("verifier");
    expect(verifierSpec?.sessionKey).not.toBe(taskSpec?.sessionKey);

    const stepAgents = new Set(t.agents.turns.map((r) => r.agentId));
    expect(stepAgents.size).toBe(1);
    const call = t.evidenceCalls[0];
    expect(stepAgents.has(call?.verifierId as string)).toBe(false);
    expect(t.agents.turns.map((r) => r.sessionKey)).not.toContain(call?.verifierKey);

    const started = t.ofType(id, "verification-started")[0]?.payload as Record<string, unknown>;
    expect(started.verifierAgentId).toBe(call?.verifierId);
    expect(started.executorAgentIds).toEqual([...stepAgents]);
    // The log attributes Steps to the executing agent only.
    const completed = t.ofType(id, "step-completed");
    expect(
      completed.every((e) => (e.payload as { agentId: string }).agentId === [...stepAgents][0]),
    ).toBe(true);
  });

  it("allocates a new Verifier session on every attempt", async () => {
    let attempts = 0;
    const t = setup({
      collect: async (ctx) =>
        ++attempts < 2 ? { type: "file_exists", exists: false } : passEvidence(ctx.check),
    });
    const { view } = await t.run({ tasks: [task("a")] });
    expect(view.state).toBe("done");
    const keys = t.agents.created.filter((s) => s.purpose === "verifier").map((s) => s.sessionKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("refuses a Verifier that is the same agent instance that ran the Task", async () => {
    const t = setup();
    t.agents.reuseTaskAgentForVerifier = true;
    const { id, view } = await t.run({ tasks: [task("a")] });
    expect(view.state).toBe("failed");
    expect(t.evidenceCalls).toEqual([]);
    expect(t.ofType(id, "verification-started")).toHaveLength(0);
    expect(view.tasks[0]?.stateReason).toContain("verifier must not share");
  });

  it("records Evidence for every check and marks the Task done only then", async () => {
    const checks: AcceptanceCheck[] = [
      { type: "tests_pass", command: "pnpm test" },
      fileCheck,
      { type: "exit_code", command: "true", expected: 0 },
      { type: "rubric", items: ["clear", "short"] },
    ];
    const t = setup();
    const { id, view } = await t.run({ tasks: [{ ...task("a"), acceptanceChecks: checks }] });
    expect(view.state).toBe("done");
    const recorded = t.ofType(id, "evidence-recorded");
    expect(recorded.map((e) => (e.payload as { checkType: string }).checkType)).toEqual([
      "tests_pass",
      "file_exists",
      "exit_code",
      "rubric",
    ]);
    expect(recorded.every((e) => (e.payload as { result: string }).result === "pass")).toBe(true);
    expect(view.tasks[0]?.verificationAttempts).toBe(1);
  });

  it("treats missing, failing and thrown Evidence as not verified", async () => {
    const outcomes: Array<Evidence | undefined | Error> = [
      undefined,
      new Error("collector crashed"),
      { type: "exit_code", exitCode: 0 }, // wrong type for a file_exists check
    ];
    let i = 0;
    const t = setup({
      collect: async () => {
        const next = outcomes[i++];
        if (next instanceof Error) throw next;
        return next;
      },
    });
    const { id, view } = await t.run({ tasks: [task("a")] });
    expect(view.state).toBe("failed");
    expect(i).toBe(3);
    expect(t.ofType(id, "evidence-failed")).toHaveLength(2);
    expect(view.tasks[0]?.stateReason).toContain("no-evidence");
  });

  it("gives up on a check whose Evidence never arrives within the limit", async () => {
    const t = setup({ collect: () => new Promise(() => undefined) });
    const { view } = await t.run({ tasks: [task("a")] });
    expect(view.state).toBe("failed");
    expect(view.tasks[0]?.stateReason).toContain("timed out");
  });
});

describe("Verification retries (Req 7.10, 7.11)", () => {
  it("returns the Task to running with failure Evidence, then fails it and never starts dependents", async () => {
    const failing: Evidence = { type: "file_exists", exists: false };
    const t = setup({
      collect: async (ctx) => (ctx.taskId === "a" ? failing : passEvidence(ctx.check)),
    });
    const { id, view } = await t.run({
      tasks: [task("a"), task("b", ["a"]), task("c", ["b"]), task("free")],
    });

    expect(view.state).toBe("failed");
    expect(view.failureReason).toContain("task failed: a");
    const states = Object.fromEntries(view.tasks.map((x) => [x.id, x.state]));
    expect(states).toEqual({ a: "failed", b: "skipped", c: "skipped", free: "done" });

    // Three verification attempts (two retries), Steps re-run before each.
    expect(view.tasks[0]?.verificationAttempts).toBe(3);
    expect(t.agents.turns.filter((r) => r.task.id === "a").map((r) => r.round)).toEqual([1, 2, 3]);

    // Dependents never get an agent, a Step or a state other than skipped.
    expect(t.agents.created.some((s) => s.taskId === "b" || s.taskId === "c")).toBe(false);
    const dependentEvents = t.events(id).filter((e) => e.taskId === "b" || e.taskId === "c");
    expect(dependentEvents.map((e) => e.type).sort()).toEqual([
      "task-created",
      "task-created",
      "task-state-changed",
      "task-state-changed",
    ]);
    expect(
      dependentEvents
        .filter((e) => e.type === "task-state-changed")
        .map((e) => (e.payload as { to: string }).to),
    ).toEqual(["skipped", "skipped"]);

    // Each retry carries the failure Evidence on the running transition.
    const aEvents = t.events(id).filter((e) => e.taskId === "a" && e.type === "task-state-changed");
    expect(aEvents.map((e) => (e.payload as { to: string }).to)).toEqual([
      "running",
      "verifying",
      "running",
      "verifying",
      "running",
      "verifying",
      "failed",
    ]);
    const retry = aEvents[2]?.payload as {
      evidence: { attempt: number; records: Array<{ evidence: Evidence }> };
    };
    expect(retry.evidence.attempt).toBe(1);
    expect(retry.evidence.records[0]?.evidence).toEqual(failing);
  });

  it("hands the failure Evidence to the next round through the Task's progress file", async () => {
    let attempt = 0;
    const t = setup({
      collect: async (ctx) =>
        ++attempt === 1 ? { type: "file_exists", exists: false } : passEvidence(ctx.check),
    });
    t.agents.turn = async (req) => {
      if (req.round === 2) expect(req.input.progress).toContain("Verification failed (attempt 1)");
      return { reply: `round ${req.round}` };
    };
    const { view } = await t.run({ tasks: [task("a")] });
    expect(view.state).toBe("done");
    expect(view.tasks[0]).toMatchObject({ result: "round 2", verificationAttempts: 2 });
    expect(t.agents.turns.map((r) => r.round)).toEqual([1, 2]);
    expect(t.fs.files.get("/progress/" + view.id + "/a.md")).toContain("file_exists");
  });
});

describe("Orchestrator surface", () => {
  it("awaitTerminal returns immediately for a finished Job and rejects for an unknown one", async () => {
    const t = setup();
    const { id, view } = await t.run({ tasks: [task("a")] });
    expect(await t.orch.awaitTerminal(id)).toEqual(view);
    await expect(t.orch.awaitTerminal("nope")).rejects.toThrow("unknown job");
    expect(t.orch.getJob("nope")).toBeUndefined();
  });

  it("awaitTerminal stops waiting when the signal aborts, without stopping the Job", async () => {
    const t = setup();
    let release!: () => void;
    t.agents.turn = () => new Promise((resolve) => (release = () => resolve({ reply: "late" })));
    const { id } = await t.orch.createJob({ goal: "g", initialPlan: { tasks: [task("a")] } });
    const controller = new AbortController();
    const waiting = t.orch.awaitTerminal(id, controller.signal);
    await until(() => typeof release === "function");
    controller.abort(new Error("stop waiting"));
    await expect(waiting).rejects.toThrow("stop waiting");
    expect(t.orch.getJob(id)?.state).toBe("running");

    release();
    expect((await t.clock.drive(t.orch.awaitTerminal(id))).state).toBe("done");
    await expect(t.orch.awaitTerminal(id, AbortSignal.abort(new Error("already")))).rejects.toThrow(
      "already",
    );
  });

  it("rejects an empty goal", async () => {
    const t = setup();
    await expect(t.orch.createJob({ goal: "  " })).rejects.toThrow(TypeError);
  });
});
