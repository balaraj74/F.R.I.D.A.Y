// Nightly Eval_Suite + Chaos_Suite run (Requirement 14.9). Mocked models and fakes only.
// Usage: node --import tsx scripts/jobs-nightly.ts [--dir <history dir>]
// Schedule it with cron or a systemd timer at the nightly time. Exits 1 on any failure.
import { createChaosScenarios } from "../tests/jobs-chaos/scenarios.js";
import { evalScenarios } from "../tests/jobs-evals/scenarios.js";
import { runNightly } from "../src/jobs/evals/nightly.js";

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag >= 0 ? process.argv[dirFlag + 1] : undefined;
if (dirFlag >= 0 && !dir) {
  console.error("--dir needs a path");
  process.exit(2);
}

const result = await runNightly({
  ...(dir ? { dir } : {}),
  evalScenarios,
  chaosScenarios: createChaosScenarios(),
});
process.stdout.write(result.report);
for (const w of result.warnings) console.error(`warning: ${w}`);
process.exit(result.run.error || result.run.scenarios.some((s) => !s.pass) ? 1 : 0);
