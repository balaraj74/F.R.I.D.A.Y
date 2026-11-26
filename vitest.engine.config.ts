// Engine track (Requirements 5-14). Same settings as the default config, narrowed to this track's files.
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["src/jobs/**/*.test.ts", "friday-hud/src/jobs/**/*.test.{ts,tsx}", "tests/jobs-evals/**/*.test.ts", "tests/jobs-chaos/**/*.test.ts"],
    exclude: baseTest.exclude ?? [],
  },
});
