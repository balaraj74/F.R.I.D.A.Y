import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Type } from "@sinclair/typebox";
import type { FRIDAYConfig } from "../../config/config.js";
import { resolveSubagentMaxConcurrent } from "../../config/agent-limits.js";
import { createOrchestrator as createRuntimeOrchestrator } from "../../jobs/orchestrator/runtime.js";
import type {
  JobView,
  Orchestrator,
  OrchestratorDeps,
} from "../../jobs/orchestrator/runtime-types.js";
import {
  createSwarmAdapter,
  openSwarmEventLog,
  type SwarmAgentSpec,
  type SwarmChildRun,
  type SwarmReport,
} from "../../jobs/orchestrator/swarm-adapter.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  deleteSwarmSessions,
  REVIEWER_PROMPT,
  runSwarmChild,
  SPECIALIST_PROMPT,
} from "./swarm-child.js";

// Agent swarm: FRIDAY splits a big task into specialist sub-agents that work in parallel
// (each with its own tools and context), waits for all of them, optionally has a reviewer
// cross-check the reports, and gets everything back in one result to merge for Sir.

const MAX_AGENTS = 8;

const SwarmSchema = Type.Object({
  goal: Type.String({ description: "The overall objective, shared with every agent." }),
  agents: Type.Array(
    Type.Object({
      name: Type.String({ description: "Short id, e.g. 'pricing' or 'competitor-a'." }),
      role: Type.String({
        description: "Specialist role, e.g. 'market researcher', 'code reviewer'.",
      }),
      task: Type.String({
        description: "Self-contained instructions: include every fact the agent needs.",
      }),
    }),
    { minItems: 2, maxItems: MAX_AGENTS },
  ),
  review: Type.Optional(
    Type.Boolean({
      description:
        "Add a reviewer that cross-checks the reports for contradictions and gaps (default: true for 3+ agents).",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({ minimum: 30, maximum: 1800, description: "Per-agent time limit (default 600)." }),
  ),
});

type AgentSpec = SwarmAgentSpec;

export type { SwarmReport };

/** Injectable pieces, so tests can fake the Orchestrator and the child agents. */
export type SwarmToolDeps = {
  /** Builds the Orchestrator from its dependencies. Default: the real runtime. */
  createOrchestrator?: (deps: OrchestratorDeps) => Orchestrator;
  /** Opens the Event_Log for one swarm. Default: in-memory. */
  openEventLog?: () => DatabaseSync;
  /** Runs one child agent. Default: gateway sub-agent run. */
  runChild?: SwarmChildRun;
  /** Removes child sessions afterwards. Default: gateway `sessions.delete`. */
  cleanupSessions?: (keys: readonly string[]) => void;
};

export function createSwarmTool(
  options: { config?: FRIDAYConfig; agentId?: string; autonomous?: boolean } & SwarmToolDeps = {},
): AnyAgentTool {
  return {
    label: "Agent Swarm",
    name: "swarm",
    description:
      "Split a large task across 2-8 specialist sub-agents that work IN PARALLEL with their own tools, wait for all of them, " +
      "and get their reports back (plus an optional reviewer cross-check) to merge into one answer for Sir. Use for big, " +
      "separable work: multi-source research, comparing options, reviewing several files/areas, drafting parts of a document. " +
      "Give each agent a distinct role and a self-contained task (they can't see this conversation or your memory). " +
      "Don't use it for small or strictly sequential tasks.",
    parameters: SwarmSchema,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const goal = readStringParam(params, "goal", { required: true });
      const raw = (params as { agents?: unknown }).agents;
      if (!Array.isArray(raw) || raw.length < 2) throw new Error("swarm needs at least 2 agents");
      const agents: AgentSpec[] = raw.slice(0, MAX_AGENTS).map((a, i) => {
        const o = (a ?? {}) as Record<string, unknown>;
        const name =
          String(o.name ?? `agent-${i + 1}`)
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(0, 32) || `agent-${i + 1}`;
        const task = String(o.task ?? "").trim();
        if (!task) throw new Error(`agent "${name}" has no task`);
        return { name, role: String(o.role ?? "specialist").slice(0, 120), task };
      });
      const timeoutMs = Math.round(
        ((params as { timeoutSeconds?: number }).timeoutSeconds ?? 600) * 1000,
      );
      const review = (params as { review?: boolean }).review ?? agents.length >= 3;
      const agentId = options.agentId ?? "main";
      const swarmId = crypto.randomBytes(3).toString("hex");
      // Sub-agents of an autonomous run stay autonomous (earned-trust gates apply to them too).
      const keyPrefix = `agent:${agentId}:subagent:${options.autonomous ? "auto-" : ""}swarm-${swarmId}`;
      const limit = Math.max(1, Math.min(resolveSubagentMaxConcurrent(options.config), 6));
      const started = Date.now();
      const adapter = createSwarmAdapter({
        goal,
        agents,
        review,
        keyPrefix,
        timeoutMs,
        concurrency: limit,
        runChild: options.runChild ?? runSwarmChild,
        specialistSystem: (a, peers) => SPECIALIST_PROMPT(goal, a, peers),
        reviewerSystem: REVIEWER_PROMPT(goal),
        signal,
        onSpecialistFinished: (done, total) =>
          onUpdate?.({
            content: [{ type: "text", text: `${done}/${total} agents finished` }],
            details: { swarmId, done, total },
          }),
      });
      const db = (options.openEventLog ?? openSwarmEventLog)();
      let view: JobView;
      try {
        const orchestrator = (options.createOrchestrator ?? createRuntimeOrchestrator)({
          ...adapter.deps,
          db,
        });
        const { id } = await orchestrator.createJob({
          goal,
          concurrencyLimit: limit,
          initialPlan: adapter.initialPlan,
        });
        view = await orchestrator.awaitTerminal(id);
      } finally {
        (options.cleanupSessions ?? deleteSwarmSessions)(adapter.sessionKeys);
        try {
          db.close();
        } catch {
          // Already closed, or a fake without close().
        }
      }
      const { reports, review: reviewReport } = adapter.buildResult(view);
      const failure =
        view.state === "done" ? undefined : (view.failureReason ?? `job ${view.state}`);
      return jsonResult({
        swarmId,
        goal,
        elapsedMs: Date.now() - started,
        parallelism: limit,
        reports,
        review: reviewReport,
        ...(failure ? { error: `Swarm job ${view.state}: ${failure}` } : {}),
        note: failure
          ? `The swarm job did not complete (${failure}). Tell Sir plainly what failed; use any usable reports below.`
          : "Merge these into one answer for Sir. Say plainly if any agent failed or timed out.",
      });
    },
  };
}
