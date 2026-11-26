// Feature: friday-design-orchestrator-harness, Property 36: Job pause/resume/cancel transitions
// **Validates: Requirements 8.10, 8.11, 8.12, 8.13**
//
// Random sequences of pause, resume, cancel, Step completion and clock movement run against a real
// Orchestrator with fake agents, a fake clock and an in-memory Event_Log. A small model of the
// expected Job and Task states is checked after every command.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ApprovalDeliveryReport, ApprovalRequest } from "../ops/notifier.js";
import { FakeClock, MemoryFs, flushMicrotasks } from "../runner/test-helpers.js";
import { loadEvents, openEventLog, projectJobState } from "../store/index.js";
import { createOrchestrator } from "./runtime.js";
import {
  JobControlError,
  type AgentFactory,
  type AgentInstance,
  type AgentSpec,
  type ApprovalNotifier,
  type OrchestratedTurnRequest,
} from "./runtime-types.js";
import type { AcceptanceCheck } from "./types.js";

const fileCheck: AcceptanceCheck = { type: "file_exists", path: "out.txt" };
type RawTask = Record<string, unknown>;
const rawTask = (id: string, dependsOn: string[] = []): RawTask => ({
  id,
  role: "builder",
  dependsOn,
  acceptanceChecks: [fileCheck],
});

type Turn = (req: OrchestratedTurnRequest) => Promise<{ reply: string }>;
const PUSH = { command: "git push origin main" };

class FakeAgents implements AgentFactory {
  /** Per-Task turn; Tasks without one finish at once. */
  turns = new Map<string, Turn>();
  started: string[] = [];
  private count = 0;
  create(spec: AgentSpec): AgentInstance {
    return {
      id: `agent-${++this.count}`,
      sessionKey: spec.sessionKey,
      runTurn: (req) => {
        this.started.push(req.task.id);
        return (this.turns.get(req.task.id) ?? (async () => ({ reply: `done ${req.task.id}` })))(
          req,
        );
      },
    };
  }
}

class FakeNotifier implements ApprovalNotifier {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDeliveryReport> {
    return Promise.resolve({
      jobId: req.jobId,
      taskId: req.taskId,
      results: [],
      anyDelivered: true,
    });
  }
  decisionApplied(): boolean {
    return true;
  }
}

function makeEnv() {
  const db = openEventLog(":memory:");
  const clock = new FakeClock();
  const agents = new FakeAgents();
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
      invoked.push((a.args as { command?: string } | undefined)?.command ?? a.tool);
      return "ok";
    },
    notifier: new FakeNotifier(),
    clock,
    fs: new MemoryFs(),
    sleep: async () => undefined,
    newId: () => `id${++ids}`,
    config: { progressDir: "/progress", models: ["m1"], concurrencyLimit: 4 },
  });
  const events = (jobId: string) => loadEvents(db, jobId);
  const ofType = (jobId: string, type: string) => events(jobId).filter((e) => e.type === type);
  /** Waits until the event log stops changing, i.e. every promise chain has run its course. */
  const settle = async (jobId: string): Promise<void> => {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 300 && stable < 4; i++) {
      await flushMicrotasks();
      const n = events(jobId).length;
      if (n === last) stable += 1;
      else {
        stable = 0;
        last = n;
      }
    }
  };
  return { db, clock, agents, invoked, orch, events, ofType, settle };
}

// ---------------------------------------------------------------------------------------
// Model: a -> b -> d, c -> d, a -> e. Every Task has one Step, held until the test releases it.
// ---------------------------------------------------------------------------------------

const IDS = ["a", "b", "c", "d", "e"] as const;
type Id = (typeof IDS)[number];
const DEPS: Record<Id, Id[]> = { a: [], b: ["a"], c: [], d: ["b", "c"], e: ["a"] };

type ModelTask = "pending" | "running" | "done" | "cancelled";
type ModelJob = "running" | "paused" | "cancelled" | "done";
type Model = {
  job: ModelJob;
  tasks: Record<Id, ModelTask>;
  /** Job states entered, in order. */
  transitions: string[];
  started: Set<Id>;
};

function startReady(m: Model): void {
  if (m.job !== "running") return;
  for (const id of IDS) {
    if (m.tasks[id] === "pending" && DEPS[id].every((d) => m.tasks[d] === "done")) {
      m.tasks[id] = "running";
      m.started.add(id);
    }
  }
}

function finishIfAllDone(m: Model): void {
  if (m.job === "running" && IDS.every((id) => m.tasks[id] === "done")) {
    m.transitions.push("verifying", "done");
    m.job = "done";
  }
}

function initialModel(): Model {
  const m: Model = {
    job: "running",
    tasks: { a: "pending", b: "pending", c: "pending", d: "pending", e: "pending" },
    transitions: ["running"],
    started: new Set(),
  };
  startReady(m);
  return m;
}

type Op =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "cancel" }
  | { kind: "release"; task: Id }
  | { kind: "releaseRunning" }
  | { kind: "advance"; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Op>({ kind: "pause" }) },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: "resume" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: "cancel" }) },
  {
    weight: 6,
    arbitrary: fc.constantFrom(...IDS).map<Op>((task) => ({ kind: "release", task })),
  },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: "releaseRunning" }) },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0, max: 60_000 }).map<Op>((ms) => ({ kind: "advance", ms })),
  },
);

const jobStateOf = (view: { state: string } | undefined) => view?.state;

describe("Feature: friday-design-orchestrator-harness, Property 36: Job pause/resume/cancel transitions", () => {
  it("follows the transition table, starts nothing while paused or after cancel, and rejects invalid or late controls", async () => {
    const sawJob = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
        const t = makeEnv();
        const resolvers = new Map<Id, () => void>();
        for (const id of IDS) {
          t.agents.turns.set(
            id,
            () =>
              new Promise((resolve) => {
                resolvers.set(id, () => resolve({ reply: `done ${id}` }));
              }),
          );
        }
        const { id: jobId } = await t.orch.createJob({
          goal: "g",
          initialPlan: { tasks: IDS.map((id) => rawTask(id, DEPS[id])) },
        });
        const m = initialModel();

        const check = (label: string) => {
          const view = t.orch.getJob(jobId);
          expect(jobStateOf(view), `${label}: job state`).toBe(m.job);
          const states = Object.fromEntries((view?.tasks ?? []).map((x) => [x.id, x.state]));
          expect(states, `${label}: task states`).toEqual(m.tasks);
          expect(new Set(t.agents.started), `${label}: started Tasks`).toEqual(m.started);
          const to = t
            .ofType(jobId, "job-state-changed")
            .map((e) => (e.payload as { to: string }).to);
          expect(to, `${label}: job state history`).toEqual(m.transitions);
        };

        const rejected = async (run: () => unknown, label: string) => {
          const before = t.events(jobId).length;
          let thrown: unknown;
          try {
            await run();
          } catch (error) {
            thrown = error;
          }
          expect(thrown, `${label} must be rejected`).toBeInstanceOf(JobControlError);
          expect(t.events(jobId).length, `${label} must not write events`).toBe(before);
        };

        const apply = async (op: Op): Promise<void> => {
          switch (op.kind) {
            case "pause":
              if (m.job === "running") {
                t.orch.pauseJob(jobId);
                m.job = "paused";
                m.transitions.push("paused");
              } else {
                await rejected(() => t.orch.pauseJob(jobId), `pause while ${m.job}`);
              }
              break;
            case "resume":
              if (m.job === "paused") {
                t.orch.resumeJob(jobId);
                m.job = "running";
                m.transitions.push("running");
                startReady(m);
                finishIfAllDone(m);
              } else {
                await rejected(() => t.orch.resumeJob(jobId), `resume while ${m.job}`);
              }
              break;
            case "cancel":
              if (m.job === "running" || m.job === "paused") {
                const at = t.clock.now();
                await t.clock.drive(t.orch.cancelJob(jobId));
                // Req 8.12: cancelled within 30 seconds.
                expect(t.clock.now() - at).toBeLessThanOrEqual(30_000);
                m.job = "cancelled";
                m.transitions.push("cancelled");
                for (const id of IDS) if (m.tasks[id] !== "done") m.tasks[id] = "cancelled";
                // Req 8.12: Leases are released.
                const steps = Object.values(
                  projectJobState(t.events(jobId)).jobs[jobId]?.steps ?? {},
                );
                expect(steps.every((s) => s.status !== "running" && s.lease === undefined)).toBe(
                  true,
                );
              } else {
                await rejected(() => t.orch.cancelJob(jobId), `cancel while ${m.job}`);
              }
              break;
            case "release": {
              // Finishes the Step if the Task has one in flight; a stale release after cancel
              // must change nothing.
              resolvers.get(op.task)?.();
              if (m.tasks[op.task] === "running") {
                m.tasks[op.task] = "done";
                startReady(m);
                finishIfAllDone(m);
              }
              break;
            }
            case "releaseRunning": {
              const inFlight = IDS.filter((id) => m.tasks[id] === "running");
              for (const id of inFlight) resolvers.get(id)?.();
              for (const id of inFlight) m.tasks[id] = "done";
              startReady(m);
              finishIfAllDone(m);
              break;
            }
            case "advance":
              await t.clock.advance(op.ms);
              break;
          }
          await t.settle(jobId);
        };

        await t.settle(jobId);
        check("after create");
        for (const [i, op] of ops.entries()) {
          await apply(op);
          sawJob.add(m.job);
          check(`after op ${i} ${JSON.stringify(op)}`);
        }
        // Whatever is left is cancelled, and a finished Job rejects every further control.
        if (m.job === "running" || m.job === "paused") {
          await apply({ kind: "cancel" });
          check("after final cancel");
        }
        for (const kind of ["pause", "resume", "cancel"] as const) {
          await apply({ kind });
          check(`terminal ${kind}`);
        }
        // Nothing starts once the Job is terminal, however long we wait or whatever completes.
        const startedBefore = new Set(t.agents.started);
        for (const id of IDS) resolvers.get(id)?.();
        await t.clock.advance(120_000);
        await t.settle(jobId);
        expect(new Set(t.agents.started)).toEqual(startedBefore);
        check("after terminal wait");
      }),
      { numRuns: 60 },
    );
    // Guard against a generator that never reaches the interesting states.
    expect(sawJob.has("paused")).toBe(true);
    expect(sawJob.has("cancelled")).toBe(true);
    expect(sawJob.has("done")).toBe(true);
  }, 120_000);

  it("on cancel discards the pending approval, cancels the waiting Task, and never performs the withheld action", async () => {
    const controlArb = fc.array(fc.constantFrom("pause", "resume"), { maxLength: 6 });
    await fc.assert(
      fc.asyncProperty(
        controlArb,
        fc.constantFrom("approve", "deny"),
        async (controls, lateDecision) => {
          const t = makeEnv();
          const results: unknown[] = [];
          t.agents.turns.set("p", async (req) => {
            results.push(await req.gate.call("exec", PUSH));
            return { reply: "pushed" };
          });
          t.agents.turns.set("d", () => new Promise(() => undefined));
          const { id: jobId } = await t.orch.createJob({
            goal: "g",
            initialPlan: { tasks: [rawTask("p"), rawTask("c", ["p"]), rawTask("d")] },
          });
          const taskState = (id: string) =>
            t.orch.getJob(jobId)?.tasks.find((x) => x.id === id)?.state;
          await t.settle(jobId);
          expect(taskState("p")).toBe("waiting_approval");

          // Pause and resume while the approval is pending, including invalid repeats.
          let paused = false;
          for (const control of controls) {
            if (control === "pause") {
              if (!paused) t.orch.pauseJob(jobId);
              else expect(() => t.orch.pauseJob(jobId)).toThrow(JobControlError);
              paused = true;
            } else {
              if (paused) t.orch.resumeJob(jobId);
              else expect(() => t.orch.resumeJob(jobId)).toThrow(JobControlError);
              paused = false;
            }
            await t.settle(jobId);
            expect(taskState("p")).toBe("waiting_approval");
          }
          const startedBefore = [...t.agents.started];

          const at = t.clock.now();
          await t.clock.drive(t.orch.cancelJob(jobId));
          expect(t.clock.now() - at).toBeLessThanOrEqual(30_000);

          const view = t.orch.getJob(jobId);
          expect(view?.state).toBe("cancelled");
          expect(view?.tasks.map((x) => [x.id, x.state])).toEqual([
            ["p", "cancelled"],
            ["c", "cancelled"],
            ["d", "cancelled"],
          ]);
          expect(t.ofType(jobId, "approval-discarded")).toHaveLength(1);
          expect(t.invoked).toEqual([]);
          const steps = Object.values(projectJobState(t.events(jobId)).jobs[jobId]?.steps ?? {});
          expect(steps.every((s) => s.status !== "running" && s.lease === undefined)).toBe(true);

          // The withheld call came back as an error, and a late decision changes nothing.
          await t.clock.advance(120_000);
          expect(results).toEqual([{ ok: false, error: expect.stringContaining("cancelled") }]);
          expect(t.orch.decideApproval(jobId, "p", lateDecision, "hud")).toMatchObject({
            ok: true,
            applied: false,
          });
          await t.settle(jobId);
          expect(taskState("p")).toBe("cancelled");
          expect(t.invoked).toEqual([]);
          expect(t.agents.started).toEqual(startedBefore);
          expect(t.orch.getJob(jobId)?.state).toBe("cancelled");
        },
      ),
      { numRuns: 30 },
    );
  }, 120_000);
});
