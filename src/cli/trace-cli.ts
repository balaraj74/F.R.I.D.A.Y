import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { defaultRuntime } from "../runtime.js";
import { formatTrace, parseTrace } from "../sessions/trace.js";

export function registerTraceCli(program: Command) {
  program
    .command("trace")
    .description("Replay a session's turns: messages, tool calls, results, errors and timings")
    .argument("[session]", "Session id (default: most recently active session)")
    .option("--last <n>", "Only the last N user turns", (v: string) => Number(v))
    .option("--json", "Print JSON")
    .action((session: string | undefined, opts: { last?: number; json?: boolean }) => {
      const cfg = loadConfig();
      const dir = resolveSessionTranscriptsDirForAgent(resolveDefaultAgentId(cfg));
      let file: string | undefined;
      if (session) {
        file = path.join(dir, session.endsWith(".jsonl") ? session : `${session}.jsonl`);
      } else {
        file = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0]?.f;
        file = file ? path.join(dir, file) : undefined;
      }
      if (!file || !fs.existsSync(file)) {
        defaultRuntime.error(
          `No session transcript found${session ? ` for ${session}` : ""} in ${dir}`,
        );
        process.exitCode = 1;
        return;
      }
      const steps = parseTrace(fs.readFileSync(file, "utf-8"));
      defaultRuntime.log(
        opts.json
          ? JSON.stringify({ file, steps }, null, 2)
          : `${path.basename(file)}\n${formatTrace(steps, { lastTurns: opts.last })}`,
      );
    });
}
