// `pnpm tune`: let DSPy (GEPA) search for better guidance wording for FRIDAY, then put the best
// candidate through the evolution gate: safety filter, the full 30-task benchmark (it must clearly
// improve her score), and finally Sir's approval in the AGI EVO tab. Needs FRIDAY running.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BENCHMARK, CATEGORIES } from "../src/agents/evolution/benchmark.js";
import { considerInstruction } from "../src/agents/evolution/engine.js";
import { loadConfig } from "../src/config/config.js";

const HOME = process.env.HOME ?? "";
const PY = path.join(HOME, ".friday", "tools", "dspy", "venv", "bin", "python");
const SCRIPT = path.join(import.meta.dirname, "..", "helpers", "dspy", "tune.py");

const cfg = loadConfig();
const workspace = (cfg.agents?.defaults?.workspace ?? path.join(HOME, "friday")).replace(/^~/, HOME);
const soul = fs.readFileSync(path.join(workspace, "SOUL.md"), "utf-8").slice(0, 8000);
// Two tasks per area to train on; the gate afterwards uses all 30.
const tasks = CATEGORIES.flatMap((c) => BENCHMARK.filter((t) => t.category === c).slice(0, 2));
const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "friday-tune-")), "input.json");
fs.writeFileSync(
  input,
  JSON.stringify({
    soul,
    tasks,
    model: "gemini-3.5-flash-lite",
    grader: "gemini-3.5-flash-lite",
    api_base: "http://localhost:8080",
    max_metric_calls: Number(process.env.TUNE_CALLS ?? 120),
  }),
);
console.log(`Tuning on ${tasks.length} tasks (this takes a while)…`);
const out = execFileSync(PY, ["-I", SCRIPT, input], {
  encoding: "utf-8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
fs.rmSync(path.dirname(input), { recursive: true, force: true });
const result = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { instruction?: string; baseline?: number; best?: number };
console.log(`Training score ${result.baseline?.toFixed(2)} → ${result.best?.toFixed(2)}`);
if (!result.instruction || (result.best ?? 0) <= (result.baseline ?? 0)) {
  console.log("No better wording found; nothing changes.");
  process.exit(0);
}
// Optimizers return the whole instruction; FRIDAY stores rules as short additions to SOUL.md.
const instruction = result.instruction.replace(/\s+/g, " ").slice(0, 300);
const proposal = await considerInstruction({
  cfg,
  workspaceDir: workspace,
  title: "Tuned guidance (DSPy)",
  why: `Optimizer improved the training score ${result.baseline?.toFixed(2)} → ${result.best?.toFixed(2)}`,
  instruction,
});
console.log(
  proposal.status === "pending"
    ? `Passed the benchmark (${proposal.benchmark?.verdict}). Waiting for your approval in AGI EVO.`
    : `Not kept: ${proposal.benchmark?.verdict}.`,
);
