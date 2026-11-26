// Eval scenarios. Each one runs the real Orchestrator and Job_Engine over an in-memory Event_Log
// with a mocked model (a scripted agent) and fake tools. No provider is ever called.
import { createRig, rawTask } from "../../src/jobs/ops/test-helpers.js";
import type { AcceptanceCheck, Evidence } from "../../src/jobs/orchestrator/types.js";
import type { EvalScenario, ScenarioKind, ScenarioOutcome } from "../../src/jobs/evals/suite.js";
import { resetJobEngineRestoreForTests } from "../../src/jobs/engine/boot.js";

type MockWorld = {
  /** Replies the mocked model gives, by Task id. */
  replies: Record<string, string>;
  /** Turns scripted into Evidence for each Acceptance_Check. */
  evidenceFor: (
    check: AcceptanceCheck,
    taskId: string,
    replies: ReadonlyMap<string, string>,
  ) => Evidence | undefined;
};

type RawPlan = { tasks: ReturnType<typeof rawTask>[] };

/** Runs a Job to its end on a fake clock and decides pass/fail from the recorded Evidence. */
async function runJobScenario(plan: RawPlan, world: MockWorld): Promise<ScenarioOutcome> {
  resetJobEngineRestoreForTests();
  const rig = createRig();
  const seen = new Map<string, string>();
  const proc = rig.boot({
    collectEvidence: async (ctx) => world.evidenceFor(ctx.check, ctx.taskId, seen),
  });
  proc.agents.turn = async (req) => {
    const reply = world.replies[req.task.id] ?? "";
    seen.set(req.task.id, reply);
    return { reply };
  };
  const { id } = await proc.orchestrator.createJob({ goal: "eval", initialPlan: plan });
  const view = await rig.clock.drive(proc.orchestrator.awaitTerminal(id));

  // The deciding Evidence is what the Verifier recorded in the log, not what the scenario assumes.
  const evidence = rig.ofType(id, "evidence-recorded").map((e) => e.payload);
  const allPass = evidence.every((p) => (p as { result?: string }).result === "pass");
  const pass = view.state === "done" && evidence.length > 0 && allPass;
  return {
    pass,
    evidence,
    ...(pass ? {} : { reason: `Job ended ${view.state}${view.failureReason ? `: ${view.failureReason}` : ""}` }),
  };
}

/** Coding: a mocked model "writes" a function; a fake test runner executes the check. */
const codingScenario: EvalScenario = {
  id: "coding-add-function",
  kind: "coding",
  run: () =>
    runJobScenario(
      {
        tasks: [
          rawTask("implement", [], {
            acceptanceChecks: [{ type: "tests_pass", command: "pnpm test add" }],
          }),
          rawTask("review", ["implement"], {
            acceptanceChecks: [{ type: "rubric", items: ["no unused code"] }],
          }),
        ],
      },
      {
        replies: {
          implement: "export const add = (a: number, b: number) => a + b;",
          review: "Looks fine: no unused code.",
        },
        evidenceFor: (check, taskId, replies) => {
          if (check.type === "tests_pass") {
            // Fake test runner: passes when the implementation is correct.
            return { type: "tests_pass", exitCode: replies.get(taskId)?.includes("a + b") ? 0 : 1 };
          }
          if (check.type === "rubric") {
            const reply = replies.get(taskId) ?? "";
            return { type: "rubric", metItems: check.items.filter((i) => reply.includes(i)) };
          }
          return undefined;
        },
      },
    ),
};

/** Research: a mocked researcher answers; a rubric decides whether the answer covers the topic. */
const researchScenario: EvalScenario = {
  id: "research-summarize-topic",
  kind: "research",
  run: () =>
    runJobScenario(
      {
        tasks: [
          rawTask("gather", [], {
            role: "researcher",
            acceptanceChecks: [{ type: "rubric", items: ["cites a source", "states a conclusion"] }],
          }),
        ],
      },
      {
        replies: {
          gather: "Source: example.org/report. Conclusion: the approach scales.",
        },
        evidenceFor: (check, taskId, replies) => {
          if (check.type !== "rubric") return undefined;
          const reply = (replies.get(taskId) ?? "").toLowerCase();
          const keywords: Record<string, string> = {
            "cites a source": "source:",
            "states a conclusion": "conclusion:",
          };
          return {
            type: "rubric",
            metItems: check.items.filter((i) => reply.includes(keywords[i] ?? "\u0000")),
          };
        },
      },
    ),
};

/** Operations: two operator Tasks run fake shell commands; exit codes are the Evidence. */
const operationsScenario: EvalScenario = {
  id: "operations-backup-and-restart",
  kind: "operations",
  run: () =>
    runJobScenario(
      {
        tasks: [
          rawTask("backup", [], {
            role: "operator",
            acceptanceChecks: [{ type: "exit_code", command: "backup.sh", expected: 0 }],
          }),
          rawTask("restart", ["backup"], {
            role: "operator",
            acceptanceChecks: [{ type: "exit_code", command: "restart.sh", expected: 0 }],
          }),
        ],
      },
      {
        replies: { backup: "backup written", restart: "service restarted" },
        evidenceFor: (check) =>
          check.type === "exit_code" ? { type: "exit_code", exitCode: 0 } : undefined,
      },
    ),
};

export const evalScenarios: EvalScenario[] = [codingScenario, researchScenario, operationsScenario];

export const scenarioKinds = (list: readonly EvalScenario[]): Set<ScenarioKind> =>
  new Set(list.map((s) => s.kind));
