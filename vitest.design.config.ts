// Design track (Requirements 1-4). Same settings as the default config, narrowed to this track's files.
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["src/design/**/*.test.ts", "friday-hud/src/design-review/**/*.test.{ts,tsx}"],
    exclude: baseTest.exclude ?? [],
  },
});
