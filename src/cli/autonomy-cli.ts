import type { Command } from "commander";

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { readAutonomyState, setAutonomyPaused } from "../infra/autonomy-state.js";
import { formatSituation, gatherSituation } from "../infra/autonomy-situation.js";
import { defaultRuntime } from "../runtime.js";

export function registerAutonomyCli(program: Command) {
  const autonomy = program
    .command("autonomy")
    .description("FRIDAY's autonomous loop: status, kill switch, situation report");

  autonomy
    .command("status")
    .description("Show whether autonomous activity is running or paused")
    .action(() => {
      const s = readAutonomyState();
      const when = s.changedAt ? ` since ${new Date(s.changedAt).toLocaleString()}` : "";
      defaultRuntime.log(
        `Autonomy: ${s.paused ? "PAUSED" : "active"}${when}${s.reason ? ` (${s.reason})` : ""}`,
      );
    });

  autonomy
    .command("pause")
    .description("Kill switch: stop the heartbeat loop and scheduled jobs until resumed")
    .option("--reason <text>", "Why (shown in status)")
    .action((opts: { reason?: string }) => {
      setAutonomyPaused(true, opts.reason);
      defaultRuntime.log(
        "Autonomy PAUSED. FRIDAY still answers you directly; she won't act on her own.",
      );
    });

  autonomy
    .command("resume")
    .description("Resume the heartbeat loop and scheduled jobs")
    .action(() => {
      setAutonomyPaused(false);
      defaultRuntime.log("Autonomy resumed.");
    });

  autonomy
    .command("situation")
    .description(
      "Print what currently needs attention (agenda, reminders, repos, system, memory proposals)",
    )
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const items = gatherSituation({
        workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
        stateDir: resolveStateDir(),
      });
      defaultRuntime.log(opts.json ? JSON.stringify({ items }, null, 2) : formatSituation(items));
    });
}
