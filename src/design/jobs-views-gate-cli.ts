// `pnpm jobs-views:gate` entry point (Requirements 15.6 and 15.7).
//
//   node --import tsx src/design/jobs-views-gate-cli.ts [--root <dir>] [--design-dir <dir>]
//
// Exit codes: 0 gate passed, 1 a dependency is incomplete (nothing is written), 64 bad usage.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatGateReport,
  runJobsViewsGate,
  type JobsViewsGateIo,
  type JobsViewsGateOptions,
} from "./jobs-views-gate.js";

export const EXIT_GATE_OK = 0;
export const EXIT_GATE_HALTED = 1;
export const EXIT_GATE_USAGE = 64;

/** Harness test files, relative to the workspace root. Matches `vitest.unit.config.ts`. */
const HARNESS_TEST_FILTER = "src/design/visual-regression";
const HARNESS_TEST_TIMEOUT_MS = 10 * 60 * 1000;

export function createNodeGateIo(workspaceDir: string): JobsViewsGateIo {
  return {
    async readFile(filePath) {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    runHarnessTests() {
      return new Promise((resolve, reject) => {
        execFile(
          "pnpm",
          ["exec", "vitest", "run", "--config", "vitest.unit.config.ts", HARNESS_TEST_FILTER],
          { cwd: workspaceDir, timeout: HARNESS_TEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const output = `${stdout}\n${stderr}`;
            if (!error) {
              resolve({ passed: true, output });
            } else if (typeof (error as NodeJS.ErrnoException).code === "string") {
              // Could not spawn (for example pnpm is not installed).
              reject(error);
            } else {
              resolve({ passed: false, output });
            }
          },
        );
      });
    },
  };
}

const USAGE = "Usage: jobs-views:gate [--root <dir>] [--design-dir <dir>]";

export type ParsedGateArgs =
  | { ok: true; options: JobsViewsGateOptions }
  | { ok: false; message: string };

export function parseGateArgs(argv: readonly string[], cwd: string): ParsedGateArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg !== "--root" && arg !== "--design-dir") {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${arg} needs a value` };
    }
    values[arg] = value;
  }
  return {
    ok: true,
    options: {
      workspaceDir: path.resolve(cwd, values["--root"] ?? "."),
      designDir: values["--design-dir"],
    },
  };
}

export async function main(
  argv: readonly string[],
  deps: {
    cwd?: string;
    createIo?: (workspaceDir: string) => JobsViewsGateIo;
    out?: (line: string) => void;
    err?: (line: string) => void;
  } = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const parsed = parseGateArgs(argv, deps.cwd ?? process.cwd());
  if (!parsed.ok) {
    err(`jobs-views:gate: ${parsed.message}\n${USAGE}`);
    return EXIT_GATE_USAGE;
  }
  const io = (deps.createIo ?? createNodeGateIo)(parsed.options.workspaceDir);
  const decision = await runJobsViewsGate(parsed.options, io);
  const report = formatGateReport(decision);
  for (const line of report) {
    (decision.ok ? out : err)(line);
  }
  return decision.ok ? EXIT_GATE_OK : EXIT_GATE_HALTED;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`jobs-views:gate: ${(error as Error).message}\n`);
      process.exitCode = EXIT_GATE_HALTED;
    },
  );
}
