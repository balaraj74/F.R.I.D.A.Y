// `pnpm benchmark`: FRIDAY's 30-task benchmark (src/agents/evolution/benchmark.ts) as a promptfoo
// suite: her real SOUL.md and main model, each reply graded against its rubric, scores by area,
// and an HTML report. Needs FRIDAY running (the model goes through her local proxy).
//   pnpm benchmark            run and write ~/.friday/benchmark/report.html
//   pnpm benchmark --view     open promptfoo's viewer on the results
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BENCHMARK } from "../src/agents/evolution/benchmark.js";
import { loadConfig } from "../src/config/config.js";

const HOME = process.env.HOME ?? "";
const OUT = path.join(HOME, ".friday", "benchmark");
const PROMPTFOO = path.join(HOME, ".friday", "tools", "promptfoo", "node_modules", ".bin", "promptfoo");
const PROXY = "http://localhost:8080";

const cfg = loadConfig();
const workspace = cfg.agents?.defaults?.workspace ?? path.join(HOME, "friday");
const soul = fs.readFileSync(path.join(workspace.replace(/^~/, HOME), "SOUL.md"), "utf-8");
const model = (cfg.agents?.defaults?.model as { primary?: string } | undefined)?.primary?.split("/").pop() ?? "gemini-3.8-flash-high";
const grader = "gemini-3.5-flash-lite";

const provider = (id: string) => ({
  id: `anthropic:messages:${id}`,
  config: {
    apiBaseUrl: PROXY,
    apiKey: "local-proxy",
    max_tokens: 3000,
    // Without a thinking budget the proxy's Gemini models can stall.
    thinking: { type: "enabled", budget_tokens: 1024 },
  },
});

const suite = {
  description: "FRIDAY benchmark",
  prompts: [JSON.stringify([{ role: "system", content: soul }, { role: "user", content: "{{input}}" }])],
  providers: [provider(model)],
  defaultTest: { options: { provider: provider(grader) } },
  tests: BENCHMARK.map((t) => ({
    description: `${t.category}/${t.id}: ${t.input.slice(0, 50)}`,
    vars: { input: t.input },
    metadata: { category: t.category },
    assert: [{ type: "llm-rubric", value: t.rubric, metric: t.category }],
  })),
  outputPath: [path.join(OUT, "results.json"), path.join(OUT, "report.html")],
};

fs.mkdirSync(OUT, { recursive: true });
const config = path.join(OUT, "promptfooconfig.yaml");
fs.writeFileSync(config, JSON.stringify(suite, null, 2)); // JSON is valid YAML
const env = {
  ...process.env,
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  PROMPTFOO_CONFIG_DIR: path.join(OUT, ".promptfoo"),
};
const args = process.argv.includes("--view")
  ? ["view", "--yes"]
  : process.argv.includes("--validate")
    ? ["validate", "-c", config]
    : ["eval", "-c", config, "--no-cache", "-j", "4"];
execFileSync(PROMPTFOO, args, { stdio: "inherit", env, cwd: OUT });
if (args[0] === "eval") console.log(`\nReport: ${path.join(OUT, "report.html")}`);
