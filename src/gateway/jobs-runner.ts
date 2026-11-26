// Gateway side of long jobs: runs each step as a real agent turn in the job's own session,
// reports to Sir on his heartbeat channel (WhatsApp), and keeps the HUD's job cards current.

import { JobRunner, jobSessionKey } from "../agents/jobs/runner.js";
import type { Job } from "../agents/jobs/store.js";
import { setJobWaker } from "../agents/tools/jobs-tool.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { type FRIDAYConfig, loadConfig } from "../config/config.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import type { OutboundChannel } from "../infra/outbound/targets.js";
import type { RuntimeEnv } from "../runtime.js";

// Job turns are background work: nothing of theirs goes to the gateway's console.
const quiet: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code: number) => {
    throw new Error(`job turn exited (${code})`);
  },
};

async function tellSir(cfg: FRIDAYConfig, text: string) {
  const hb = cfg.agents?.defaults?.heartbeat;
  const channel = (hb?.target ?? "none") as OutboundChannel;
  if (channel === "none" || !hb?.to) return;
  await deliverOutboundPayloads({
    cfg,
    channel: channel as Exclude<OutboundChannel, "none">,
    to: hb.to,
    payloads: [{ text }],
    bestEffort: true,
  });
}

export function startJobRunner(broadcast: (job: Job) => void): () => void {
  const runner = new JobRunner({
    runTurn: async (sessionKey, message) => {
      const res = await agentCommand(
        {
          message,
          sessionKey,
          deliver: false,
          json: true,
          messageChannel: "job",
          lane: "job",
          runId: `job_${Date.now()}`,
        },
        quiet,
        createDefaultDeps(),
      );
      return (res?.payloads ?? [])
        .map((p) => p.text ?? "")
        .filter(Boolean)
        .join("\n")
        .trim();
    },
    notify: (text) => tellSir(loadConfig(), text),
    broadcast,
  });
  setJobWaker(() => runner.kick());
  // Pick up jobs that were running when the app was closed.
  const resume = setTimeout(() => runner.kick(), 15_000);
  return () => {
    clearTimeout(resume);
    setJobWaker(null);
  };
}

export { jobSessionKey };
