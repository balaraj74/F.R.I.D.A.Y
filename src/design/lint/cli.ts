// `pnpm design:lint` entry point. All IO goes through `LintIo` so tests can use a fake file system.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HUD_SRC_DIR,
  LINT_BASELINE_FILE_NAME,
  TAILWIND_TOKENS_FILE_NAME,
  TOKENS_CSS_FILE_NAME,
  resolveDesignPaths,
} from "../paths.js";
import { parseLintBaseline, serializeLintBaseline } from "./baseline.js";
import { decideExit } from "./decide.js";
import { scanFile } from "./scan.js";
import { collectSourceFiles, mapLimit, type DirEntry } from "./tree.js";
import type { Violation } from "./types.js";

/** Exit codes. 1 is "above baseline" (Req 3.4); 2 is "unreadable input" (Req 3.7). */
export const EXIT_OK = 0;
export const EXIT_ABOVE_BASELINE = 1;
export const EXIT_UNREADABLE = 2;
export const EXIT_USAGE = 64;

/** Concurrent file reads. Keeps the scan well inside 30s for 2,000 files without exhausting descriptors. */
export const READ_CONCURRENCY = 32;

export interface LintIo {
  readFile(filePath: string): Promise<string>;
  /** Writes via a temp file and rename so a failed write never leaves a partial baseline. */
  writeFileAtomic(filePath: string, content: string): Promise<void>;
  listDir(dir: string): Promise<DirEntry[]>;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
}

export interface LintCliOptions {
  rootDir: string;
  srcDir: string;
  tokenFile: string;
  baselineFile: string;
  writeBaseline: boolean;
}

export const nodeLintIo: LintIo = {
  readFile: (filePath) => fs.readFile(filePath, "utf8"),
  async writeFileAtomic(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, content, "utf8");
      await fs.rename(temp, filePath);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  },
  async listDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
  },
  now: () => new Date(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = [
  "Usage: design:lint [--write-baseline] [--root <dir>] [--src <dir>] [--token-file <file>] [--baseline <file>]",
  "  --write-baseline  record the current Off_System_Value count as the baseline and exit 0",
].join("\n");

export type ParsedArgs = { ok: true; options: LintCliOptions } | { ok: false; message: string };

/** Parses argv (without node and script). Relative paths resolve against `cwd`, `--src`/`--token-file`/`--baseline` defaults against the root. */
export function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
  const values: Record<string, string> = {};
  let writeBaseline = false;
  const valueFlags = new Set(["--root", "--src", "--token-file", "--baseline"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--write-baseline") {
      writeBaseline = true;
    } else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `${arg} needs a value` };
      }
      values[arg] = value;
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }
  const rootDir = path.resolve(cwd, values["--root"] ?? ".");
  const designPaths = resolveDesignPaths(rootDir);
  return {
    ok: true,
    options: {
      rootDir,
      srcDir: path.resolve(rootDir, values["--src"] ?? HUD_SRC_DIR),
      tokenFile: path.resolve(rootDir, values["--token-file"] ?? designPaths.tokens),
      baselineFile: path.resolve(
        rootDir,
        values["--baseline"] ?? path.join(designPaths.dir, LINT_BASELINE_FILE_NAME),
      ),
      writeBaseline,
    },
  };
}

/** The radius scale is every key and value of the Token_File `radius` category. */
function readRadiusScale(raw: string): { scale: string[] } | { reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { reason: `invalid JSON: ${(error as Error).message}` };
  }
  const radius = (data as { radius?: unknown } | null)?.radius;
  if (typeof radius !== "object" || radius === null || Array.isArray(radius)) {
    return { reason: "missing `radius` category" };
  }
  const scale: string[] = [];
  for (const [key, value] of Object.entries(radius)) {
    if (typeof value !== "string") {
      return { reason: `radius token \`${key}\` is not a string` };
    }
    scale.push(key, value);
  }
  return { scale };
}

const GENERATED_BASENAMES: ReadonlySet<string> = new Set([
  TOKENS_CSS_FILE_NAME,
  TAILWIND_TOKENS_FILE_NAME,
]);

function unreadable(io: LintIo, file: string, reason: string): number {
  io.err(`design:lint: cannot read ${file}: ${reason}`);
  return EXIT_UNREADABLE;
}

/** Runs the linter and returns the process exit code. */
export async function runDesignLint(options: LintCliOptions, io: LintIo): Promise<number> {
  // Token_File first: the radius scale is needed by every scan.
  let tokenRaw: string;
  try {
    tokenRaw = await io.readFile(options.tokenFile);
  } catch (error) {
    return unreadable(io, options.tokenFile, (error as Error).message);
  }
  const radius = readRadiusScale(tokenRaw);
  if ("reason" in radius) {
    return unreadable(io, options.tokenFile, radius.reason);
  }

  let baselineCount = 0;
  if (!options.writeBaseline) {
    let baselineRaw: string;
    try {
      baselineRaw = await io.readFile(options.baselineFile);
    } catch (error) {
      return unreadable(io, options.baselineFile, (error as Error).message);
    }
    const parsed = parseLintBaseline(baselineRaw);
    if (!parsed.ok) {
      return unreadable(io, options.baselineFile, parsed.reason);
    }
    baselineCount = parsed.baseline.count;
  }

  const walk = await collectSourceFiles(options.srcDir, io.listDir, READ_CONCURRENCY);
  if (walk.unreadable.length > 0) {
    for (const item of walk.unreadable) {
      unreadable(io, item.path, item.reason);
    }
    return EXIT_UNREADABLE;
  }

  type FileResult =
    | { violations: Violation[]; failure?: undefined }
    | { failure: { file: string; reason: string }; violations?: undefined };
  const results = await mapLimit<string, FileResult>(walk.files, READ_CONCURRENCY, async (file) => {
    try {
      const content = await io.readFile(file);
      const rel = path.relative(options.rootDir, file).split(path.sep).join("/");
      const generated = GENERATED_BASENAMES.has(path.basename(file));
      return { violations: scanFile(rel, content, radius.scale, generated) };
    } catch (error) {
      return { failure: { file, reason: (error as Error).message } };
    }
  });
  const failures = results.flatMap((r) => (r.failure ? [r.failure] : []));
  if (failures.length > 0) {
    for (const f of failures) {
      unreadable(io, f.file, f.reason);
    }
    return EXIT_UNREADABLE;
  }
  const violations: Violation[] = results.flatMap((r) => r.violations ?? []);
  for (const v of violations) {
    io.out(`${v.file}:${v.line} ${v.rule}`);
  }

  if (options.writeBaseline) {
    try {
      await io.writeFileAtomic(
        options.baselineFile,
        serializeLintBaseline({
          version: 1,
          count: violations.length,
          recordedAt: io.now().toISOString(),
        }),
      );
    } catch (error) {
      io.err(`design:lint: cannot write ${options.baselineFile}: ${(error as Error).message}`);
      return EXIT_UNREADABLE;
    }
    io.out(
      `Recorded baseline of ${violations.length} Off_System_Values in ${options.baselineFile}`,
    );
    return EXIT_OK;
  }

  const { exitCode } = decideExit(violations.length, baselineCount);
  if (exitCode === 1) {
    io.out(
      `${violations.length - baselineCount} violations above the baseline (${violations.length} found, baseline ${baselineCount})`,
    );
    return EXIT_ABOVE_BASELINE;
  }
  io.out(`${violations.length} Off_System_Values found, within the baseline of ${baselineCount}`);
  return EXIT_OK;
}

/** Parses argv and runs the linter. */
export async function main(argv: readonly string[], io: LintIo = nodeLintIo): Promise<number> {
  const parsed = parseArgs(argv, process.cwd());
  if (!parsed.ok) {
    io.err(`design:lint: ${parsed.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  return runDesignLint(parsed.options, io);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`design:lint: ${(error as Error).message}\n`);
      process.exitCode = EXIT_UNREADABLE;
    },
  );
}
