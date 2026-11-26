import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { readLatestAssistantReply } from "./agent-step.js";
import type { SwarmAgentSpec, SwarmChildRun } from "../../jobs/orchestrator/swarm-adapter.js";

// Child-agent spawning for the swarm tool: one gateway run per specialist, each under its own
// sessionKey. The Orchestrator drives these through the swarm adapter's `runChild` hook.

const WAIT_SLICE_MS = 60_000;

export const SPECIALIST_PROMPT = (goal: string, a: SwarmAgentSpec, peers: string[]) =>
  [
    `You are the "${a.name}" specialist (${a.role}) in FRIDAY's agent team.`,
    `Team goal: ${goal}`,
    peers.length
      ? `Other specialists working in parallel: ${peers.join(", ")}. Stay in your lane; don't duplicate their work.`
      : "",
    "Work independently with your tools; nobody will answer questions. When done, reply with a concise report:",
    "1) findings/result, 2) evidence (sources, file paths, commands run), 3) confidence and open questions.",
    "Never claim something ran or was verified unless it did.",
  ]
    .filter(Boolean)
    .join("\n");

export const REVIEWER_PROMPT = (goal: string) =>
  [
    "You are the reviewer in FRIDAY's agent team.",
    `Team goal: ${goal}`,
    "Below are the specialists' reports. Cross-check them: flag contradictions, unsupported claims and gaps,",
    "verify the most important claims with your tools where you can, then give a merged, deduplicated brief.",
  ].join("\n");

/** Runs one child agent to completion through the gateway and returns its final report. */
export const runSwarmChild: SwarmChildRun = async (params) => {
  const idem = crypto.randomUUID();
  const started = (await callGateway({
    method: "agent",
    params: {
      message: params.message,
      sessionKey: params.sessionKey,
      idempotencyKey: idem,
      deliver: false,
      channel: INTERNAL_MESSAGE_CHANNEL,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: params.system,
    },
    timeoutMs: 10_000,
  })) as { runId?: string };
  const runId = started?.runId || idem;
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      await callGateway({
        method: "chat.abort",
        params: { sessionKey: params.sessionKey, runId },
        timeoutMs: 5_000,
      }).catch(() => {});
      return { status: "aborted", report: "" };
    }
    const slice = Math.min(WAIT_SLICE_MS, deadline - Date.now());
    const wait = (await callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: slice },
      timeoutMs: slice + 5_000,
    })) as { status?: string; error?: string };
    if (wait?.status === "ok") {
      return {
        status: "ok",
        report: (await readLatestAssistantReply({ sessionKey: params.sessionKey })) ?? "",
      };
    }
    if (wait?.status && wait.status !== "timeout")
      return { status: "error", report: wait.error ?? wait.status };
  }
  await callGateway({
    method: "chat.abort",
    params: { sessionKey: params.sessionKey, runId },
    timeoutMs: 5_000,
  }).catch(() => {});
  return {
    status: "timeout",
    report:
      (await readLatestAssistantReply({ sessionKey: params.sessionKey }).catch(() => "")) ?? "",
  };
};

/** Child sessions are scratch space: drop them so they don't clutter Sir's chat list. */
export function deleteSwarmSessions(keys: readonly string[]): void {
  for (const key of keys) {
    void callGateway({
      method: "sessions.delete",
      params: { key, deleteTranscript: false },
      timeoutMs: 5_000,
    }).catch(() => {});
  }
}
