// `pnpm design:migrate:gate` entry point (Requirements 4.1, 4.9 and 15.4).
//
//   design:migrate:gate [check] [--root <dir>] [--design-dir <dir>]
//   design:migrate:gate record <approved-by-user|declined|unresolved> [--note <text>] [--root <dir>] [--design-dir <dir>]
//
// Exit codes: 0 gate passed (or decision recorded), 1 the gate refuses, 64 bad usage.
// Neither command runs git.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PUSH_DECISIONS,
  formatMigrationGateReport,
  recordPushDecision,
  runMigrationGate,
  type MigrationGateIo,
  type MigrationGateOptions,
  type PushDecision,
} from "./migration-gate.js";

export const EXIT_MIGRATION_OK = 0;
export const EXIT_MIGRATION_REFUSED = 1;
export const EXIT_MIGRATION_USAGE = 64;

export function createNodeMigrationGateIo(): MigrationGateIo {
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
    async fileExists(filePath) {
      try {
        return (await fs.stat(filePath)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
  };
}

const USAGE =
  "Usage: design:migrate:gate [check] [--root <dir>] [--design-dir <dir>]\n" +
  `       design:migrate:gate record <${PUSH_DECISIONS.join("|")}> [--note <text>] [--root <dir>] [--design-dir <dir>]`;

export type ParsedMigrationArgs =
  | { ok: true; command: "check"; options: MigrationGateOptions }
  | {
      ok: true;
      command: "record";
      options: MigrationGateOptions;
      pushDecision: PushDecision;
      note?: string;
    }
  | { ok: false; message: string };

export function parseMigrationArgs(argv: readonly string[], cwd: string): ParsedMigrationArgs {
  const args = [...argv];
  let command: "check" | "record" = "check";
  if (args[0] === "check" || args[0] === "record") {
    command = args.shift() as "check" | "record";
  }
  let pushDecision: PushDecision | undefined;
  if (command === "record") {
    const value = args.shift();
    if (!value || !PUSH_DECISIONS.includes(value as PushDecision)) {
      return { ok: false, message: `record needs one of: ${PUSH_DECISIONS.join(", ")}` };
    }
    pushDecision = value as PushDecision;
  }
  const allowed =
    command === "record" ? ["--root", "--design-dir", "--note"] : ["--root", "--design-dir"];
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!allowed.includes(arg)) {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${arg} needs a value` };
    }
    values[arg] = value;
  }
  const options: MigrationGateOptions = {
    workspaceDir: path.resolve(cwd, values["--root"] ?? "."),
    designDir: values["--design-dir"],
  };
  return command === "record"
    ? {
        ok: true,
        command,
        options,
        pushDecision: pushDecision as PushDecision,
        note: values["--note"],
      }
    : { ok: true, command, options };
}

export async function main(
  argv: readonly string[],
  deps: {
    cwd?: string;
    io?: MigrationGateIo;
    out?: (line: string) => void;
    err?: (line: string) => void;
    record?: typeof recordPushDecision;
  } = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const parsed = parseMigrationArgs(argv, deps.cwd ?? process.cwd());
  if (!parsed.ok) {
    err(`design:migrate:gate: ${parsed.message}\n${USAGE}`);
    return EXIT_MIGRATION_USAGE;
  }

  if (parsed.command === "record") {
    const written = await (deps.record ?? recordPushDecision)(parsed.options, parsed.pushDecision, {
      note: parsed.note,
    });
    out(
      `Recorded push decision "${written.file.pushDecision}" for ${written.file.branch} in ${written.path}`,
    );
    return EXIT_MIGRATION_OK;
  }

  const decision = await runMigrationGate(parsed.options, deps.io ?? createNodeMigrationGateIo());
  for (const line of formatMigrationGateReport(decision)) {
    (decision.ok ? out : err)(line);
  }
  return decision.ok ? EXIT_MIGRATION_OK : EXIT_MIGRATION_REFUSED;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`design:migrate:gate: ${(error as Error).message}\n`);
      process.exitCode = EXIT_MIGRATION_REFUSED;
    },
  );
}
