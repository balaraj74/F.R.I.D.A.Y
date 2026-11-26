// Swarm adapter (Requirement 7.12-7.14): maps a swarm request onto an Orchestrator Job and the
// Job's outcome back onto the Swarm_Tool report shape. It builds the Orchestrator's injectable
// dependencies, so the Swarm_Tool stays a thin wrapper and tests can fake any part of this.
//
// Design choices:
// - Task graph: one Task per specialist (no dependencies, so they run in parallel up to the
//   concurrency limit) plus an optional `reviewer` Task that depends on all of them.
// - Child agents are the same gateway sub-agent runs the swarm always used (`runChild`), each in
//   its own sessionKey. A child that errors, times out or is aborted does NOT fail its Task: the
//   outcome is recorded and surfaced as that agent's report status, as before. A Job therefore
//   fails only on orchestration errors (plan rejected, budget, step runner or log failure).
// - Acceptance_Checks: every Task gets one `rubric` check ("the agent's outcome was recorded").
//   The evidence collector judges it deterministically from the outcome ledger, with no model
//   call, because the swarm contract is "report whatever each agent produced", not "prove it is
//   correct". Content cross-checking remains the optional reviewer's job.
// - Verifier agents are lightweight placeholders in their own session; they never spawn a child.
// - Progress files are kept in memory, and the Event_Log is in-memory by default (see
//   `openSwarmEventLog`), so a swarm never leaves Job state for boot recovery to resume.
import type { DatabaseSync } from "node:sqlite";
import type { RunnerFs } from "../runner/deps.js";
import { openEventLog } from "../store/log.js";
import type {
  AgentFactory,
  AgentInstance,
  EvidenceCollector,
  JobView,
  OrchestratedTurnRequest,
  OrchestratorDeps,
  PlannerAgent,
} from "./runtime-types.js";

export type SwarmAgentSpec = { name: string; role: string; task: string };

export type SwarmReport = {
  name: string;
  role: string;
  status: "ok" | "timeout" | "error" | "aborted";
  report: string;
  ms: number;
};

export type SwarmChildRun = (params: {
  sessionKey: string;
  message: string;
  system: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ status: SwarmReport["status"]; report: string }>;

export const SWARM_REVIEWER_NAME = "reviewer";
export const SWARM_REVIEWER_ROLE = "cross-checker";
/** The one rubric item every swarm Task carries. */
export const SWARM_RUBRIC_ITEM = "The agent's outcome (report or failure status) was recorded";
/** How often a running child tells the Step_Runner it is alive (its stall limit is 120s). */
export const SWARM_HEARTBEAT_MS = 15_000;
/** Margin added to the per-agent timeout so the child's own timeout fires before the Step's. */
const STEP_TIMEOUT_MARGIN_SECONDS = 60;
/** One Step per Task: far under the Proxy reply cap. */
const SWARM_REPLY_ESTIMATE_TOKENS = 1_000;

export type SwarmAdapterInput = {
  goal: string;
  agents: SwarmAgentSpec[];
  review: boolean;
  /** Session key prefix; agents run under `${keyPrefix}-${name}` and `${keyPrefix}-reviewer`. */
  keyPrefix: string;
  timeoutMs: number;
  /** Max agents running at once (1 to 16). */
  concurrency: number;
  runChild: SwarmChildRun;
  specialistSystem: (a: SwarmAgentSpec, peers: string[]) => string;
  reviewerSystem: string;
  /** Aborts the children (not the Job's bookkeeping). */
  signal?: AbortSignal;
  /** Called after each specialist finishes. */
  onSpecialistFinished?: (done: number, total: number) => void;
};

type Outcome = { status: SwarmReport["status"]; report: string; ms: number; skipped?: boolean };
type Entry = {
  taskId: string;
  name: string;
  role: string;
  sessionKey: string;
  spec?: SwarmAgentSpec;
  reviewer: boolean;
};

export type SwarmAdapter = {
  /** Plan for `createJob({ initialPlan })`. */
  initialPlan: unknown;
  /** Dependencies for `createOrchestrator`, minus the database. */
  deps: Omit<OrchestratorDeps, "db">;
  /** Every child session key, for cleanup. The reviewer's key is always included. */
  sessionKeys: string[];
  /** Maps the finished Job back to the existing report shape. */
  buildResult(view: JobView): { reports: SwarmReport[]; review?: SwarmReport };
};

/** Aborts when either signal does. */
function anySignal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

export function createSwarmAdapter(input: SwarmAdapterInput): SwarmAdapter {
  const specialists: Entry[] = input.agents.map((spec, i) => ({
    taskId: `agent-${i + 1}-${spec.name}`,
    name: spec.name,
    role: spec.role,
    sessionKey: `${input.keyPrefix}-${spec.name}`,
    spec,
    reviewer: false,
  }));
  const reviewer: Entry | undefined = input.review
    ? {
        taskId: SWARM_REVIEWER_NAME,
        name: SWARM_REVIEWER_NAME,
        role: SWARM_REVIEWER_ROLE,
        sessionKey: `${input.keyPrefix}-${SWARM_REVIEWER_NAME}`,
        reviewer: true,
      }
    : undefined;
  const byTask = new Map<string, Entry>(
    [...specialists, ...(reviewer ? [reviewer] : [])].map((e) => [e.taskId, e]),
  );
  const outcomes = new Map<string, Outcome>();
  let finished = 0;

  const check = [{ type: "rubric", items: [SWARM_RUBRIC_ITEM] }];
  const taskPlan = (e: Entry, dependsOn: string[]) => ({
    id: e.taskId,
    role: e.reviewer ? "reviewer" : "researcher", // nominal: children are gated by their own tools
    dependsOn,
    acceptanceChecks: check,
    estimatedReplyTokens: SWARM_REPLY_ESTIMATE_TOKENS,
    title: e.name,
    instructions: e.spec?.task ?? "Cross-check the specialists' reports.",
  });
  const initialPlan = {
    tasks: [
      ...specialists.map((e) => taskPlan(e, [])),
      ...(reviewer
        ? [
            taskPlan(
              reviewer,
              specialists.map((e) => e.taskId),
            ),
          ]
        : []),
    ],
  };

  const usableReports = () =>
    specialists.flatMap((e) => {
      const o = outcomes.get(e.taskId);
      return o && o.status === "ok" && o.report.trim() ? [{ e, o }] : [];
    });

  async function runEntry(e: Entry, req: OrchestratedTurnRequest) {
    // A verification retry re-runs the Step; never spawn the child twice.
    const existing = outcomes.get(e.taskId);
    if (existing) return { reply: replyFor(existing), progressNote: existing.status };
    const t0 = Date.now();
    const beat = setInterval(() => req.reportActivity(), SWARM_HEARTBEAT_MS);
    beat.unref?.();
    let outcome: Outcome;
    try {
      const signal = anySignal(input.signal, req.signal);
      if (e.reviewer) {
        const usable = usableReports();
        if (usable.length < 2 || signal.aborted) {
          outcome = { status: "ok", report: "", ms: 0, skipped: true };
        } else {
          const r = await input.runChild({
            sessionKey: e.sessionKey,
            message: usable
              .map(({ e: s, o }) => `### ${s.name} (${s.role})\n${o.report}`)
              .join("\n\n"),
            system: input.reviewerSystem,
            timeoutMs: input.timeoutMs,
            signal,
          });
          outcome = { ...r, ms: Date.now() - t0 };
        }
      } else {
        const spec = e.spec as SwarmAgentSpec;
        const r = await input.runChild({
          sessionKey: e.sessionKey,
          message: spec.task,
          system: input.specialistSystem(
            spec,
            input.agents.filter((x) => x !== spec).map((x) => `${x.name} (${x.role})`),
          ),
          timeoutMs: input.timeoutMs,
          signal,
        });
        outcome = { ...r, ms: Date.now() - t0 };
      }
    } catch (err) {
      outcome = { status: "error", report: String(err), ms: Date.now() - t0 };
    } finally {
      clearInterval(beat);
    }
    outcomes.set(e.taskId, outcome);
    if (!e.reviewer) input.onSpecialistFinished?.(++finished, specialists.length);
    return { reply: replyFor(outcome), progressNote: outcome.status };
  }

  // The Step_Runner treats an empty reply as a failed attempt, so never return one.
  const replyFor = (o: Outcome) =>
    o.skipped
      ? "reviewer skipped: fewer than 2 usable reports"
      : o.report.trim() || `(no report; status: ${o.status})`;

  let verifierCount = 0;
  const agents: AgentFactory = {
    create(spec) {
      if (spec.purpose === "verifier") {
        const inst: AgentInstance = {
          id: `swarm-verifier-${++verifierCount}`,
          sessionKey: spec.sessionKey,
          async runTurn() {
            throw new Error("swarm verifier agents do not run turns");
          },
        };
        return inst;
      }
      const e = byTask.get(spec.taskId);
      if (!e) throw new Error(`unknown swarm task ${spec.taskId}`);
      // The instance reports the session it really runs in, so the existing child session
      // keys stay stable and still differ from the verifier's.
      const inst: AgentInstance = {
        id: `swarm-agent-${e.taskId}`,
        sessionKey: e.sessionKey,
        runTurn: (req) => runEntry(e, req),
      };
      return inst;
    },
  };

  const collectEvidence: EvidenceCollector = async ({ check: c, taskId }) => {
    if (c.type !== "rubric") return undefined;
    return { type: "rubric", metItems: outcomes.has(taskId) ? [...c.items] : [] };
  };

  // The plan is fixed; if validation ever rejects it, fail the Job instead of improvising.
  const planner: PlannerAgent = async () => {
    throw new Error("swarm plan is fixed and cannot be re-planned");
  };

  // Progress files are scratch for a swarm; keep them in memory.
  const files = new Map<string, string>();
  const fs: RunnerFs = {
    async readText(p) {
      return files.get(p) ?? null;
    },
    async writeText(p, text) {
      files.set(p, text);
    },
  };

  const stepTimeoutSeconds = Math.ceil(input.timeoutMs / 1000) + STEP_TIMEOUT_MARGIN_SECONDS;

  return {
    initialPlan,
    sessionKeys: [
      ...specialists.map((e) => e.sessionKey),
      `${input.keyPrefix}-${SWARM_REVIEWER_NAME}`,
    ],
    deps: {
      planner,
      agents,
      collectEvidence,
      fs,
      config: {
        concurrencyLimit: input.concurrency,
        progressDir: "swarm-progress",
        stepTimeoutSeconds,
      },
    },
    buildResult(view) {
      const reports: SwarmReport[] = specialists.map((e) => {
        const o = outcomes.get(e.taskId);
        if (o) return { name: e.name, role: e.role, status: o.status, report: o.report, ms: o.ms };
        const t = view.tasks.find((x) => x.id === e.taskId);
        return {
          name: e.name,
          role: e.role,
          status: "error",
          report: `did not complete: ${t?.stateReason ?? view.failureReason ?? "job " + view.state}`,
          ms: 0,
        };
      });
      const ro = reviewer ? outcomes.get(reviewer.taskId) : undefined;
      const review: SwarmReport | undefined =
        reviewer && ro && !ro.skipped
          ? {
              name: reviewer.name,
              role: reviewer.role,
              status: ro.status,
              report: ro.report,
              ms: ro.ms,
            }
          : undefined;
      return { reports, ...(review ? { review } : {}) };
    },
  };
}

/** In-memory Event_Log for one swarm. Swarm Jobs are ephemeral, so nothing is left to recover. */
export function openSwarmEventLog(): DatabaseSync {
  return openEventLog(":memory:");
}
