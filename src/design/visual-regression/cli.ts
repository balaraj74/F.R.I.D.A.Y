// Command-line entry for the Visual_Regression_Harness.
//
//   node --import tsx src/design/visual-regression/cli.ts [--update] [--screen <name>]...
//
// The HUD must already be running (`pnpm --dir friday-hud dev` or `preview`).
// Exit codes: 0 all captures pass (or were updated), 1 a capture failed, 2 invalid usage.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_AA_TOLERANCE_PIXELS,
  DEFAULT_BASE_URL,
  DEFAULT_BASELINE_DIR,
  DEFAULT_CHANNEL_THRESHOLD,
  DEFAULT_DIFF_DIR,
} from "./config.js";
import {
  comparePngs,
  createPlaywrightScreenCapture,
  readFileIfExists,
  writeFileAtomic,
} from "./defaults.js";
import {
  runVisualRegression,
  type HarnessDeps,
  type HarnessOptions,
  type HarnessResult,
} from "./harness.js";

const USAGE = `Usage: visual-regression [options]
  --update                 overwrite baselines with the new captures
  --screen <name>          only this screen (repeatable)
  --base-url <url>         HUD URL (default ${DEFAULT_BASE_URL})
  --baseline-dir <dir>     baseline PNGs
  --diff-dir <dir>         where diff images are written
  --aa-tolerance <pixels>  differing pixels forgiven as anti-aliasing (default ${DEFAULT_AA_TOLERANCE_PIXELS})
  --channel-threshold <n>  per-channel difference (0-255) a pixel may have (default ${DEFAULT_CHANNEL_THRESHOLD})
  --executable-path <path> Chrome/Chromium executable`;

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export function formatResult(r: HarnessResult): string {
  const name = `${r.screen}@${r.size}`;
  switch (r.status) {
    case "pass":
      return `PASS     ${name}`;
    case "updated":
      return `UPDATED  ${name}  ${r.baselinePath}`;
    case "fail-diff":
      return `FAIL     ${name}  ${r.diffPixels} differing pixels${r.diffPath ? `, diff: ${r.diffPath}` : ""}`;
    case "fail-missing-baseline":
      return `FAIL     ${name}  missing baseline ${r.baselinePath} (run with --update to create it)`;
    case "error":
      return `ERROR    ${name}  ${r.message ?? "unknown error"}`;
  }
}

function parseNonNegativeInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

/** Runs the harness. `deps` is injectable for tests; by default it uses Playwright and sharp. */
export async function runCli(
  argv: string[],
  io: CliIo = {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
  },
  deps?: HarnessDeps,
): Promise<0 | 1 | 2> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        update: { type: "boolean" },
        screen: { type: "string", multiple: true },
        "base-url": { type: "string" },
        "baseline-dir": { type: "string" },
        "diff-dir": { type: "string" },
        "aa-tolerance": { type: "string" },
        "channel-threshold": { type: "string" },
        "executable-path": { type: "string" },
        help: { type: "boolean" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    io.out(USAGE);
    return 0;
  }

  let options: HarnessOptions;
  try {
    options = {
      baseUrl: (v["base-url"] as string | undefined) ?? DEFAULT_BASE_URL,
      baselineDir: path.resolve((v["baseline-dir"] as string | undefined) ?? DEFAULT_BASELINE_DIR),
      diffDir: path.resolve((v["diff-dir"] as string | undefined) ?? DEFAULT_DIFF_DIR),
      update: v.update === true,
      aaTolerancePixels: parseNonNegativeInt(
        v["aa-tolerance"] as string | undefined,
        DEFAULT_AA_TOLERANCE_PIXELS,
        "--aa-tolerance",
      ),
      channelThreshold: parseNonNegativeInt(
        v["channel-threshold"] as string | undefined,
        DEFAULT_CHANNEL_THRESHOLD,
        "--channel-threshold",
      ),
      only: v.screen as string[] | undefined,
    };
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }

  const playwright = deps
    ? undefined
    : createPlaywrightScreenCapture({
        executablePath: v["executable-path"] as string | undefined,
      });
  const effectiveDeps: HarnessDeps = deps ?? {
    capture: (playwright as NonNullable<typeof playwright>).capture,
    diff: comparePngs,
    readFile: readFileIfExists,
    writeFile: writeFileAtomic,
  };
  const withReport: HarnessDeps = {
    ...effectiveDeps,
    report: (r) => io.out(formatResult(r)),
  };

  try {
    const report = await runVisualRegression(options, withReport);
    if (report.usageError) {
      io.err(`${report.usageError}\n${USAGE}`);
    } else {
      const failed = report.results.filter((r) => r.status !== "pass" && r.status !== "updated");
      io.out(
        `${report.results.length - failed.length}/${report.results.length} ${options.update ? "updated" : "passed"}`,
      );
    }
    return report.exitCode;
  } finally {
    await playwright?.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
