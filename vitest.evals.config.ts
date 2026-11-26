// Eval_Suite, Chaos_Suite and nightly report, mocked models only. Same settings as the default config, narrowed to this track's files.
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["tests/jobs-evals/**/*.test.ts", "tests/jobs-chaos/**/*.test.ts", "src/jobs/evals/**/*.test.ts"],
    exclude: baseTest.exclude ?? [],
  },
});
