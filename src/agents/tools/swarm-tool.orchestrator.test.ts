// Wrapper tests for the Swarm_Tool over the Orchestrator (Requirements 7.12-7.14): a Job is
// created and awaited, success keeps the SwarmReport[] shape, failure returns an error result in
// that same shape. No gateway is involved; children are faked through `runChild`.
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createOrchestrator } from "../../jobs/orchestrator/runtime.js";
import type {
  CreateJobInput,
  JobView,
  Orchestrator,
  OrchestratorDeps,
} from "../../jobs/orchestrator/runtime-types.js";
import {
  createSwarmAdapter,
  openSwarmEventLog,
  SWARM_RUBRIC_ITEM,
  type SwarmChildRun,
} from "../../jobs/orchestrator/swarm-adapter.js";
import { createSwarmTool } from "./swarm-tool.js";

type Details = {
  swarmId: string;
  goal: string;
  parallelism: number;
  reports: Array<{ name: string; role: string; status: string; report: string; ms: number }>;
  review?: { name: string; status: string; report: string };
  error?: string;
  note: string;
};

const AGENTS = [
  { name: "alpha", role: "researcher", task: "Research A" },
  { name: "beta", role: "researcher", task: "Research B" },
];

/** Orchestrator whose Job always ends in `view`, recording what the tool asked of it. */
function fakeOrchestrator(view: Partial<JobView>, order: string[] = []) {
  const created: CreateJobInput[] = [];
  const seen: { deps?: OrchestratorDeps } = {};
  const create = (deps: OrchestratorDeps): Orchestrator => {
    seen.deps = deps;
    return {
      createJob: async (input: CreateJobInput) => {
        order.push("createJob");
        created.push(input);
        return { id: "job-1" };
      },
      awaitTerminal: async (id: string) => {
        order.push("awaitTerminal");
        await new Promise((r) => setTimeout(r, 10));
        order.push("terminal");
        return {
          id,
          state: "done",
          createdAtMs: 0,
          updatedAtMs: 0,
          tasks: [],
          ...view,
        } as JobView;
      },
    } as unknown as Orchestrator;
  };
  return { create, created, seen };
}

describe("swarm tool over the Orchestrator", () => {
  it("returns the SwarmReport[] shape when the Job is done", async () => {
    const runChild: SwarmChildRun = vi.fn(async ({ sessionKey }) => ({
      status: "ok",
      report: `report from ${sessionKey.split("-").pop()}`,
    }));
    const cleaned: string[][] = [];
    const tool = createSwarmTool({
      agentId: "main",
      runChild,
      cleanupSessions: (keys) => cleaned.push([...keys]),
    });
    const res = await tool.execute("t1", { goal: "Compare", agents: AGENTS, review: false });
    const d = res.details as Details;
    expect(d.error).toBeUndefined();
    expect(d.goal).toBe("Compare");
    expect(d.reports.map((r) => [r.name, r.role, r.status, r.report])).toEqual([
      ["alpha", "researcher", "ok", "report from alpha"],
      ["beta", "researcher", "ok", "report from beta"],
    ]);
    expect(d.review).toBeUndefined();
    expect(d.note).toMatch(/Merge these/);
    expect(runChild).toHaveBeenCalledTimes(2);
    // Sessions are removed afterwards: both specialists plus the reviewer key.
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toHaveLength(3);
  });

  it("includes the reviewer report and keeps child failures as report status", async () => {
    const runChild: SwarmChildRun = async ({ sessionKey }) => {
      if (sessionKey.endsWith("-reviewer")) return { status: "ok", report: "cross-checked" };
      if (sessionKey.endsWith("-gamma")) return { status: "timeout", report: "" };
      return { status: "ok", report: `report ${sessionKey.split("-").pop()}` };
    };
    const tool = createSwarmTool({ runChild, cleanupSessions: () => {} });
    const res = await tool.execute("t2", {
      goal: "g",
      agents: [...AGENTS, { name: "gamma", role: "pricing", task: "Prices" }],
    });
    const d = res.details as Details;
    // A child timing out does not fail the Job; it shows up as that agent's status.
    expect(d.error).toBeUndefined();
    expect(d.reports.map((r) => [r.name, r.status])).toEqual([
      ["alpha", "ok"],
      ["beta", "ok"],
      ["gamma", "timeout"],
    ]);
    expect(d.review?.report).toBe("cross-checked");
  });

  it("creates a Job from the swarm plan and waits for its terminal state", async () => {
    const order: string[] = [];
    const fake = fakeOrchestrator({ state: "done" }, order);
    const db = {} as DatabaseSync;
    const openEventLog = vi.fn(() => db);
    const tool = createSwarmTool({
      createOrchestrator: fake.create,
      openEventLog,
      runChild: async () => ({ status: "ok", report: "x" }),
      cleanupSessions: () => order.push("cleanup"),
    });
    await tool.execute("t3", { goal: "Plan it", agents: AGENTS, review: true });
    // The tool must not return (or clean up) before the Job is terminal.
    expect(order).toEqual(["createJob", "awaitTerminal", "terminal", "cleanup"]);
    expect(openEventLog).toHaveBeenCalledTimes(1);
    expect(fake.seen.deps?.db).toBe(db);
    expect(fake.created).toHaveLength(1);
    const job = fake.created[0];
    expect(job.goal).toBe("Plan it");
    const tasks = (job.initialPlan as { tasks: Array<{ id: string; dependsOn: string[] }> }).tasks;
    expect(tasks.map((t) => t.id)).toEqual(["agent-1-alpha", "agent-2-beta", "reviewer"]);
    expect(tasks[2].dependsOn).toEqual(["agent-1-alpha", "agent-2-beta"]);
  });

  it("returns an error result in the same shape, with the reason, when the Job fails", async () => {
    const cleaned: string[][] = [];
    const fake = fakeOrchestrator({ state: "failed", failureReason: "job budget exceeded" });
    const tool = createSwarmTool({
      createOrchestrator: fake.create,
      runChild: async () => ({ status: "ok", report: "x" }),
      cleanupSessions: (keys) => cleaned.push([...keys]),
    });
    const res = await tool.execute("t4", { goal: "Doomed", agents: AGENTS });
    const d = res.details as Details;
    expect(d.error).toBe("Swarm job failed: job budget exceeded");
    expect(d.note).toContain("job budget exceeded");
    expect(d.goal).toBe("Doomed");
    // Same shape as success: one report per agent, each marked as not completed.
    expect(d.reports.map((r) => [r.name, r.status])).toEqual([
      ["alpha", "error"],
      ["beta", "error"],
    ]);
    expect(d.reports[0].report).toBe("did not complete: job budget exceeded");
    expect(d.parallelism).toBeGreaterThanOrEqual(1);
    expect(cleaned).toHaveLength(1);
  });

  it("names the Job state when a failed Job has no reason", async () => {
    const fake = fakeOrchestrator({ state: "cancelled" });
    const tool = createSwarmTool({
      createOrchestrator: fake.create,
      runChild: async () => ({ status: "ok", report: "x" }),
      cleanupSessions: () => {},
    });
    const d = (await tool.execute("t5", { goal: "g", agents: AGENTS })).details as Details;
    expect(d.error).toBe("Swarm job cancelled: job cancelled");
  });

  it("still cleans up child sessions when the Orchestrator throws", async () => {
    const cleanup = vi.fn();
    const close = vi.fn();
    const tool = createSwarmTool({
      createOrchestrator: () => {
        throw new Error("boom");
      },
      openEventLog: () => ({ close }) as unknown as DatabaseSync,
      runChild: async () => ({ status: "ok", report: "x" }),
      cleanupSessions: cleanup,
    });
    await expect(tool.execute("t6", { goal: "g", agents: AGENTS })).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects fewer than 2 agents before creating a Job", async () => {
    const create = vi.fn();
    const tool = createSwarmTool({ createOrchestrator: create });
    await expect(tool.execute("t7", { goal: "g", agents: [AGENTS[0]] })).rejects.toThrow(
      /at least 2 agents/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createSwarmAdapter", () => {
  function build(runChild: SwarmChildRun, review: boolean, onSpecialistFinished?: () => void) {
    return createSwarmAdapter({
      goal: "goal",
      agents: AGENTS,
      review,
      keyPrefix: "agent:main:subagent:swarm-abc",
      timeoutMs: 5_000,
      concurrency: 2,
      runChild,
      specialistSystem: (a, peers) => `${a.name} peers=${peers.join(",")}`,
      reviewerSystem: "reviewer system",
      onSpecialistFinished,
    });
  }

  async function run(adapter: ReturnType<typeof build>) {
    const db = openSwarmEventLog();
    try {
      const orchestrator = createOrchestrator({ ...adapter.deps, db });
      const { id } = await orchestrator.createJob({
        goal: "goal",
        initialPlan: adapter.initialPlan,
      });
      return await orchestrator.awaitTerminal(id);
    } finally {
      db.close();
    }
  }

  it("builds one Task per agent, plus a reviewer depending on all of them", () => {
    const adapter = build(async () => ({ status: "ok", report: "x" }), true);
    const tasks = (
      adapter.initialPlan as {
        tasks: Array<{
          id: string;
          dependsOn: string[];
          acceptanceChecks: Array<{ type: string; items: string[] }>;
        }>;
      }
    ).tasks;
    expect(tasks.map((t) => t.id)).toEqual(["agent-1-alpha", "agent-2-beta", "reviewer"]);
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[2].dependsOn).toEqual(["agent-1-alpha", "agent-2-beta"]);
    expect(tasks.every((t) => t.acceptanceChecks[0].items[0] === SWARM_RUBRIC_ITEM)).toBe(true);
    expect(adapter.sessionKeys).toEqual([
      "agent:main:subagent:swarm-abc-alpha",
      "agent:main:subagent:swarm-abc-beta",
      "agent:main:subagent:swarm-abc-reviewer",
    ]);
  });

  it("omits the reviewer Task when review is off", () => {
    const adapter = build(async () => ({ status: "ok", report: "x" }), false);
    expect((adapter.initialPlan as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it("maps a done Job to reports with the fake child's output", async () => {
    const runChild = vi.fn<SwarmChildRun>(async ({ sessionKey, system }) =>
      sessionKey.endsWith("-reviewer")
        ? { status: "ok", report: "merged" }
        : { status: "ok", report: `done: ${system}` },
    );
    const finished = vi.fn();
    const adapter = build(runChild, true, finished);
    const view = await run(adapter);
    expect(view.state).toBe("done");
    const { reports, review } = adapter.buildResult(view);
    expect(reports.map((r) => [r.name, r.status, r.report])).toEqual([
      ["alpha", "ok", "done: alpha peers=beta (researcher)"],
      ["beta", "ok", "done: beta peers=alpha (researcher)"],
    ]);
    expect(review).toMatchObject({ name: "reviewer", status: "ok", report: "merged" });
    expect(finished).toHaveBeenCalledTimes(2);
    expect(runChild).toHaveBeenCalledTimes(3);
  });

  it("records a throwing or failing child as that agent's status without failing the Job", async () => {
    const adapter = build(async ({ sessionKey }) => {
      if (sessionKey.endsWith("-alpha")) throw new Error("child crashed");
      return { status: "error", report: "" };
    }, true);
    const view = await run(adapter);
    expect(view.state).toBe("done");
    const { reports, review } = adapter.buildResult(view);
    expect(reports.map((r) => r.status)).toEqual(["error", "error"]);
    expect(reports[0].report).toContain("child crashed");
    // Fewer than 2 usable reports: the reviewer is skipped and not reported.
    expect(review).toBeUndefined();
  });

  it("reports every agent as not completed when the Job failed before running them", () => {
    const adapter = build(async () => ({ status: "ok", report: "x" }), true);
    const { reports, review } = adapter.buildResult({
      id: "j",
      state: "failed",
      failureReason: "plan rejected",
      createdAtMs: 0,
      updatedAtMs: 0,
      tasks: [],
    });
    expect(reports.map((r) => [r.status, r.report, r.ms])).toEqual([
      ["error", "did not complete: plan rejected", 0],
      ["error", "did not complete: plan rejected", 0],
    ]);
    expect(review).toBeUndefined();
  });
});
