import type { Command } from "commander";

import {
  isTrusted,
  loadTrust,
  markBriefSent,
  morningBrief,
  neverAutoReason,
  readAutonomousActions,
  setGrant,
  TRUST_THRESHOLD,
  undoAction,
} from "../infra/autonomy-trust.js";
import { defaultRuntime } from "../runtime.js";

export function registerTrustCli(program: Command) {
  const trust = program
    .command("trust")
    .description("Earned trust: what FRIDAY may do on her own, her track record, and undo");

  trust
    .command("status", { isDefault: true })
    .description("Track record per action kind and whether it runs autonomously")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => {
      const data = loadTrust();
      if (opts.json) return defaultRuntime.log(JSON.stringify(data, null, 2));
      const kinds = Object.entries(data.kinds).sort(
        (a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail),
      );
      if (!kinds.length)
        return defaultRuntime.log(
          "No track record yet. It builds as FRIDAY runs commands and edits files.",
        );
      defaultRuntime.log(
        `Autonomous after ${TRUST_THRESHOLD} clean runs in a row. Hard-never commands always ask.\n`,
      );
      for (const [kind, r] of kinds) {
        const never = neverAutoReason(kind);
        const state = never
          ? "always asks"
          : r.revoked
            ? "revoked"
            : isTrusted(kind, data)
              ? r.granted
                ? "trusted (granted)"
                : "trusted"
              : `asks (${r.streak}/${TRUST_THRESHOLD})`;
        defaultRuntime.log(
          `${kind.padEnd(24)} ${String(r.ok).padStart(4)} ok ${String(r.fail).padStart(3)} failed   ${state}`,
        );
      }
    });

  trust
    .command("grant <kind...>")
    .description(
      'Let FRIDAY do this kind on her own now (e.g. friday trust grant "systemctl restart")',
    )
    .action((words: string[]) => {
      const kind = words.join(" ");
      const never = neverAutoReason(kind);
      if (never) throw new Error(`\`${kind}\` ${never}; it always asks.`);
      setGrant(kind, true);
      defaultRuntime.log(`Granted: FRIDAY may \`${kind}\` on her own.`);
    });

  trust
    .command("revoke <kind...>")
    .description("Make FRIDAY ask again before doing this kind on her own")
    .action((words: string[]) => {
      const kind = words.join(" ");
      setGrant(kind, false);
      defaultRuntime.log(`Revoked: FRIDAY will ask before \`${kind}\` when acting on her own.`);
    });

  trust
    .command("log")
    .description("Actions FRIDAY took on her own")
    .option("--days <n>", "How far back", "3")
    .action((opts: { days: string }) => {
      const since = Date.now() - Number(opts.days) * 86400_000;
      const actions = readAutonomousActions({ sinceMs: since });
      if (!actions.length) return defaultRuntime.log("No autonomous actions in that window.");
      for (const a of actions) {
        const undo = a.snapshot
          ? "  [undo: friday trust undo " + a.id + "]"
          : a.undo
            ? `  [undo: ${a.undo}]`
            : "";
        defaultRuntime.log(
          `${new Date(a.at).toLocaleString("en-IN")}  ${a.ok ? "✓" : "✕"} ${a.what.slice(0, 140)}${undo}`,
        );
      }
    });

  trust
    .command("brief")
    .description("The morning brief: what FRIDAY did on her own since the last one")
    .option("--sent", "Mark the brief as delivered")
    .action((opts: { sent?: boolean }) => {
      if (opts.sent) {
        markBriefSent();
        return defaultRuntime.log("Brief marked as sent.");
      }
      const brief = morningBrief();
      defaultRuntime.log(
        brief.count ? brief.text : "Nothing done autonomously since the last brief.",
      );
    });

  trust
    .command("undo <actionId>")
    .description("Undo an autonomous file change (or show how to reverse a command)")
    .action((id: string) => {
      defaultRuntime.log(undoAction(id));
    });
}
