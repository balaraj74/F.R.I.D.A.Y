import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { scanForCommitments } from "../agents/commitments/extract.js";
import {
  describeCommitment,
  dueBucket,
  loadCommitments,
  updateCommitment,
  upsertCommitment,
} from "../agents/commitments/store.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { defaultRuntime } from "../runtime.js";

export function registerCommitmentsCli(program: Command) {
  const cmd = program
    .command("commitments")
    .description("Promises and deadlines FRIDAY tracks for you");

  cmd
    .command("list", { isDefault: true })
    .description("Show open commitments, most urgent first")
    .option("--all", "Include done and dismissed")
    .option("--json", "Print JSON")
    .action((opts: { all?: boolean; json?: boolean }) => {
      const now = new Date();
      const order = { overdue: 0, soon: 1, today: 2, week: 3, later: 4, undated: 5 } as const;
      const list = loadCommitments()
        .filter((c) => opts.all || c.status === "open")
        .sort(
          (a, b) =>
            order[dueBucket(a, now)] - order[dueBucket(b, now)] ||
            (a.due ?? "").localeCompare(b.due ?? ""),
        );
      if (opts.json) return defaultRuntime.log(JSON.stringify({ commitments: list }, null, 2));
      if (!list.length) return defaultRuntime.log("No open commitments.");
      for (const c of list)
        defaultRuntime.log(
          `${c.status === "open" ? "•" : c.status === "done" ? "✓" : "–"} ${describeCommitment(c, now)}`,
        );
    });

  cmd
    .command("add <text...>")
    .description("Track a commitment by hand")
    .option("--who <name>", "Other person involved")
    .option("--owner <owner>", "sir (default) | other | friday")
    .option("--due <iso>", "Deadline, ISO 8601 (e.g. 2026-10-24T18:00+05:30)")
    .action((words: string[], opts: { who?: string; owner?: string; due?: string }) => {
      if (opts.due && Number.isNaN(Date.parse(opts.due))) throw new Error("--due must be ISO 8601");
      const { commitment, created } = upsertCommitment({
        text: words.join(" "),
        who: opts.who,
        owner: opts.owner === "other" || opts.owner === "friday" ? opts.owner : "sir",
        due: opts.due ? new Date(opts.due).toISOString() : undefined,
        source: { kind: "manual", at: new Date().toISOString() },
      });
      defaultRuntime.log(
        `${created ? "Added" : "Already tracked"}: ${describeCommitment(commitment)}`,
      );
    });

  for (const [name, status] of [
    ["done", "done"],
    ["dismiss", "dismissed"],
  ] as const) {
    cmd
      .command(`${name} <id>`)
      .description(
        name === "done"
          ? "Mark a commitment done"
          : "Drop a commitment that isn't real or relevant",
      )
      .action((id: string) => {
        const c = updateCommitment(id, { status });
        if (!c) throw new Error(`No commitment with id ${id}`);
        defaultRuntime.log(`${status}: ${describeCommitment(c)}`);
      });
  }

  cmd
    .command("scan")
    .description("Read new conversation lines now and pick up commitments (normally every 20 min)")
    .action(async () => {
      const cfg = loadConfig();
      const res = await scanForCommitments({
        cfg,
        sessionsDir: resolveSessionTranscriptsDirForAgent(resolveDefaultAgentId(cfg)),
      });
      defaultRuntime.log(
        `Read ${res.lines} new lines; ${res.seen} candidates; ${res.added} new commitment(s).`,
      );
    });
}
