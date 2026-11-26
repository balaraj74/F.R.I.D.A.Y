// Loop_Detector and Router wiring in the Orchestrator (Requirements 10.3, 10.4, 10.5, 10.6, 10.9).
// Agents, clock and file system are fakes; no model or network is used.
import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFs } from "../runner/test-helpers.js";
import { loadEvents, openEventLog } from "../store/index.js";
import { ORCHESTRATOR_EVENT_TYPES } from "./events.js";
import type { LoopControlDeps } from "./loop-control.js";
import { createOrchestrator } from "./runtime.js";
import type {
  AgentFactory,
  AgentInstance,
  AgentSpec,
  OrchestratedTurnRequest,
} from "./runtime-types.js";

type Turn = (req: OrchestratedTurnRequest) => Promise<{ reply: string }>;

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "builder",
  dependsOn: [],
  acceptanceChecks: [{ type: "file_exists", path: "out.txt" }],
  ...extra,
});

/** Ten Steps: each Step is capped at 64k expected reply tokens. */
const TEN_STEPS = 640_000;

function setup(opts: { models?: string[]; loopControl?: LoopControlDeps; turn: Turn }) {
  const db = openEventLog(":memory:");
  const clock = new FakeClock();
  const fs = new MemoryFs();
  const turns: OrchestratedTurnRequest[] = [];
  let count = 0;
  const agents: AgentFactory = {
    create(spec: AgentSpec): AgentInstance {
      return {
        id: `agent-${++count}`,
        sessionKey: spec.sessionKey,
        runTurn: (req) => {
          turns.push(req);
          return opts.turn(req);
        },
      };
    },
  };
  let ids = 0;
  const orch = createOrchestrator({
    db,
    planner: async () => {
      throw new Error("planner should not be called");
    },
    agents,
    collectEvidence: async () => ({ type: "file_exists", exists: true }),
    ...(opts.loopControl ? { loopControl: opts.loopControl } : {}),
    clock,
    fs,
    sleep: async () => undefined,
    newId: () => `id${++ids}`,
    config: { progressDir: "/progress", models: opts.models ?? ["m1"] },
  });
  const run = async (tasks: unknown[]) => {
    const { id } = await orch.createJob({ goal: "g", initialPlan: { tasks } });
    const view = await clock.drive(orch.awaitTerminal(id));
    return { id, view, events: loadEvents(db, id) };
  };
  return { fs, turns, run };
}

const repeatCall: Turn = async (req) => {
  await req.gate.call("exec", { command: "ls" });
  return { reply: `step ${req.step.index}` };
};

describe("Loop_Detector wiring (Req 10.3, 10.4, 10.9)", () => {
  it("flags a Task repeating one call every Step by the 10th Step with default config", async () => {
    const notices: string[] = [];
    const t = setup({
      models: ["m1", "m2"],
      loopControl: { notifier: { notify: (text: string) => (notices.push(text), { held: false }) } },
      turn: repeatCall,
    });
    const { view, events } = await t.run([task("loopy", { estimatedReplyTokens: TEN_STEPS })]);

    const flags = events.filter((e) => e.type === ORCHESTRATOR_EVENT_TYPES.loopFlagged);
    expect(flags.length).toBeGreaterThanOrEqual(1);
    const firstStep = Number(flags[0]?.stepId?.split(".").at(-1));
    expect(firstStep).toBeLessThanOrEqual(10);
    expect(view.state).toBe("failed");
    expect(view.tasks[0]?.state).toBe("failed");
    expect(view.failureReason).toContain("loopy");
    expect(notices).toHaveLength(1);
  });

  it("changes approach on the first flag and records the action, then fails on the repeat", async () => {
    const notices: string[] = [];
    const t = setup({
      models: ["m1", "m2"],
      loopControl: { notifier: { notify: (text: string) => (notices.push(text), { held: false }) } },
      turn: repeatCall,
    });
    const { view, events } = await t.run([
      task("loopy", { title: "Fix build", estimatedReplyTokens: TEN_STEPS }),
    ]);

    const flags = events.filter((e) => e.type === ORCHESTRATOR_EVENT_TYPES.loopFlagged);
    expect(flags).toHaveLength(2);
    expect(flags[0]?.payload).toMatchObject({
      response: "change-approach",
      action: "switch-model",
    });
    expect(flags[1]?.payload).toMatchObject({ response: "fail-task" });

    // Steps after the first flag run on the next model in the list.
    const flaggedStep = Number(flags[0]?.stepId?.split(".").at(-1));
    const after = t.turns.filter((r) => r.step.index > flaggedStep);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.model === "m2")).toBe(true);
    expect(t.turns.filter((r) => r.step.index <= flaggedStep).every((r) => r.model === "m1")).toBe(
      true,
    );

    // The Task failed, its earlier Step results are still in the log, and the user was told.
    expect(view.tasks[0]?.state).toBe("failed");
    expect(view.tasks[0]?.stateReason).toContain("repeated loop");
    expect(events.filter((e) => e.type === "step-completed").length).toBeGreaterThanOrEqual(
      flaggedStep,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("loopy");
    expect(notices[0]).toContain("repeated loop");
  });

  it("changes the plan through progress.md when no stronger model exists", async () => {
    const t = setup({ models: ["only"], turn: repeatCall });
    const { events } = await t.run([task("solo", { estimatedReplyTokens: TEN_STEPS })]);
    const first = events.find((e) => e.type === ORCHESTRATOR_EVENT_TYPES.loopFlagged);
    expect(first?.payload).toMatchObject({ response: "change-approach", action: "change-plan" });
    expect(t.fs.files.get("/progress/" + first?.jobId + "/solo.md")).toContain("Loop detected");
  });

  it("does not flag a Task whose calls differ", async () => {
    const t = setup({
      turn: async (req) => {
        await req.gate.call("exec", { command: `echo ${req.step.index}` });
        return { reply: "ok" };
      },
    });
    const { view, events } = await t.run([task("fine", { estimatedReplyTokens: TEN_STEPS })]);
    expect(view.state).toBe("done");
    expect(events.some((e) => e.type === ORCHESTRATOR_EVENT_TYPES.loopFlagged)).toBe(false);
  });

  it("keeps the default detector settings when the configured ones are invalid", async () => {
    const t = setup({
      loopControl: { config: { repeatThreshold: 1, windowSize: 10, similarityThreshold: 0.85 } },
      turn: repeatCall,
    });
    const { events } = await t.run([task("loopy", { estimatedReplyTokens: TEN_STEPS })]);
    const flags = events.filter((e) => e.type === ORCHESTRATOR_EVENT_TYPES.loopFlagged);
    // Default threshold 3 flags on the 4th call.
    expect(flags[0]?.stepId?.endsWith(".4")).toBe(true);
  });
});

describe("Router wiring (Req 10.5, 10.6)", () => {
  it("sends low-complexity Steps to the fast model and the rest to the main model", async () => {
    const t = setup({
      models: ["main-1"],
      loopControl: { fastModels: ["fast-1"] },
      turn: async (req) => ({ reply: "ok" }),
    });
    await t.run([task("small", { estimatedReplyTokens: 200 }), task("big", {})]);
    expect(t.turns.find((r) => r.task.id === "small")?.model).toBe("fast-1");
    expect(t.turns.find((r) => r.task.id === "big")?.model).toBe("main-1");
  });

  it("sends verifier Steps to the main model even when small", async () => {
    const t = setup({
      models: ["main-1"],
      loopControl: { fastModels: ["fast-1"] },
      turn: async () => ({ reply: "ok" }),
    });
    await t.run([task("check", { role: "verifier", estimatedReplyTokens: 100 })]);
    expect(t.turns[0]?.model).toBe("main-1");
  });

  it("orders the fallback list with models under 30s median latency first", async () => {
    const t = setup({
      models: ["slow", "quick"],
      loopControl: {
        modelLatencies: [
          { id: "slow", medianLatencyMs: 45_000 },
          { id: "quick", medianLatencyMs: 2_000 },
        ],
      },
      turn: async () => ({ reply: "ok" }),
    });
    await t.run([task("a", {})]);
    expect(t.turns[0]?.model).toBe("quick");
  });
});
