// Fakes for resume and Proxy-restart tests: an Orchestrator rig that can be "rebooted" against the
// same Event_Log, agents whose turns can be made to hang or fail, and a HealthClock backed by the
// runner FakeClock so one `drive()` advances both. Excluded from the build by tsconfig.
import type { DatabaseSync } from "node:sqlite";

import { createOrchestrator } from "../orchestrator/runtime.js";
import type {
  AgentFactory,
  AgentInstance,
  AgentSpec,
  OrchestratedTurnRequest,
  Orchestrator,
  OrchestratorDeps,
  StepProxyRecovery,
} from "../orchestrator/runtime-types.js";
import type { AcceptanceCheck, Evidence } from "../orchestrator/types.js";
import { FakeClock, MemoryFs } from "../runner/test-helpers.js";
import { loadEvents, openEventLog, type AppendedEvent } from "../store/index.js";
import type { HealthClock } from "./health.js";

export const fileCheck: AcceptanceCheck = { type: "file_exists", path: "out.txt" };

export type RawTask = {
  id: string;
  role: string;
  dependsOn: string[];
  acceptanceChecks: AcceptanceCheck[];
  estimatedReplyTokens?: number;
};

export const rawTask = (
  id: string,
  dependsOn: string[] = [],
  extra: Partial<RawTask> = {},
): RawTask => ({ id, role: "builder", dependsOn, acceptanceChecks: [fileCheck], ...extra });

export function passEvidence(check: AcceptanceCheck): Evidence {
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

/** A HealthClock driven by a runner FakeClock. */
export function healthClockFrom(clock: FakeClock): HealthClock {
  return {
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimer(fn, ms),
    clearTimeout: (handle) => (handle as () => void)(),
  };
}

export type TurnBehavior = (req: OrchestratedTurnRequest) => Promise<{ reply: string }>;

/** Agents that record every Step turn. `turn` decides what each turn does. */
export class RigAgents implements AgentFactory {
  turns: OrchestratedTurnRequest[] = [];
  private count = 0;
  turn: TurnBehavior = async (req) => ({ reply: `result of ${req.task.id}` });

  create(spec: AgentSpec): AgentInstance {
    return {
      id: `agent-${spec.jobId}-${++this.count}`,
      sessionKey: spec.sessionKey,
      runTurn: (req) => {
        this.turns.push(req);
        return this.turn(req);
      },
    };
  }

  stepIds(): string[] {
    return this.turns.map((t) => t.stepId);
  }
}

export type RigOptions = {
  db?: DatabaseSync;
  clock?: FakeClock;
  fs?: MemoryFs;
};

/** One Gateway "process": its own Orchestrator and agents over a shared database, clock and disk. */
export function createRig(opts: RigOptions = {}) {
  const db = opts.db ?? openEventLog(":memory:");
  const clock = opts.clock ?? new FakeClock();
  const fs = opts.fs ?? new MemoryFs();
  let boots = 0;

  function boot(
    over: {
      planner?: OrchestratorDeps["planner"];
      collectEvidence?: OrchestratorDeps["collectEvidence"];
      proxyRecovery?: StepProxyRecovery;
      models?: string[];
    } = {},
  ) {
    const agents = new RigAgents();
    const bootNo = ++boots;
    let ids = 0;
    const orchestrator: Orchestrator = createOrchestrator({
      db,
      planner:
        over.planner ??
        (async () => {
          throw new Error("planner should not be called");
        }),
      agents,
      collectEvidence: over.collectEvidence ?? (async (ctx) => passEvidence(ctx.check)),
      clock,
      fs,
      sleep: async () => undefined,
      newId: () => `b${bootNo}-${++ids}`,
      ...(over.proxyRecovery ? { proxyRecovery: over.proxyRecovery } : {}),
      config: { progressDir: "/progress", models: over.models ?? ["m1"] },
    });
    return { orchestrator, agents };
  }

  const events = (jobId: string): AppendedEvent[] => loadEvents(db, jobId);
  const ofType = (jobId: string, type: string) => events(jobId).filter((e) => e.type === type);
  return { db, clock, fs, boot, events, ofType };
}

export const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
