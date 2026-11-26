// HUD migration gate (Requirements 4.1, 4.9 and 15.4).
//
// The HUD migration (task 6) may start only when
//   1. the user has answered the push question for branch `upgrade/pi-1.5`
//      (recorded in `design/migration-decision.json`), and
//   2. the Design_Spec (`DESIGN.md`) and the Token_File (`tokens.json`) exist.
//
// The gate is read-only: `MigrationGateIo` has no write method, so a refusing gate cannot change
// HUD source. The module never runs git. The agent never pushes; the user does it themselves
// (Requirement 15.4), so "approved-by-user" only records that the user answered.
//
// Layout: `gatherMigrationFacts` does the IO, `decideMigrationGate` is the pure decision,
// `formatMigrationGateReport` renders it. `recordPushDecision` is the only writer.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MIGRATION_DECISION_FILE_NAME, resolveDesignPaths } from "./paths.js";

/** Branch the push question is about. */
export const MIGRATION_BRANCH = "upgrade/pi-1.5";

export const PUSH_DECISIONS = ["approved-by-user", "declined", "unresolved"] as const;
export type PushDecision = (typeof PUSH_DECISIONS)[number];

export interface MigrationDecisionFile {
  version: 1;
  branch: string;
  pushDecision: PushDecision;
  /** ISO-8601 timestamp of when the user answered. */
  decidedAt: string;
  note?: string;
}

export interface MigrationGateOptions {
  workspaceDir: string;
  /** Overrides `<workspaceDir>/design`. */
  designDir?: string;
}

/** Read-only IO for the gate. */
export interface MigrationGateIo {
  /** File content, or `undefined` when the file does not exist. Throws on any other read error. */
  readFile(filePath: string): Promise<string | undefined>;
  /** True when a regular file exists at the path. */
  fileExists(filePath: string): Promise<boolean>;
}

export function resolveMigrationDecisionPath(options: MigrationGateOptions): string {
  return path.join(
    resolveDesignPaths(options.workspaceDir, options.designDir).dir,
    MIGRATION_DECISION_FILE_NAME,
  );
}

export type DecisionFacts =
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; reason: string }
  | { status: "present"; path: string; file: MigrationDecisionFile };

export interface MigrationGateFacts {
  decision: DecisionFacts;
  designSpec: { path: string; exists: boolean };
  tokenFile: { path: string; exists: boolean };
}

export type MigrationBlockerCode =
  | "push-decision-unresolved"
  | "design-spec-missing"
  | "token-file-missing";

export interface MigrationBlocker {
  code: MigrationBlockerCode;
  path: string;
  detail: string;
}

export type MigrationGateDecision =
  | { ok: true; blockers: [] }
  | { ok: false; blockers: MigrationBlocker[] };

/** Validates parsed JSON. Returns the file, or the reason it is not a valid decision for the branch. */
export function parseDecisionFile(
  value: unknown,
): { ok: true; file: MigrationDecisionFile } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1) {
    return { ok: false, reason: "version must be 1" };
  }
  if (typeof v.branch !== "string" || v.branch.length === 0) {
    return { ok: false, reason: "branch must be a non-empty string" };
  }
  if (!PUSH_DECISIONS.includes(v.pushDecision as PushDecision)) {
    return { ok: false, reason: `pushDecision must be one of ${PUSH_DECISIONS.join(", ")}` };
  }
  if (typeof v.decidedAt !== "string" || Number.isNaN(Date.parse(v.decidedAt))) {
    return { ok: false, reason: "decidedAt must be an ISO-8601 timestamp" };
  }
  if (v.note !== undefined && typeof v.note !== "string") {
    return { ok: false, reason: "note must be a string" };
  }
  return {
    ok: true,
    file: {
      version: 1,
      branch: v.branch,
      pushDecision: v.pushDecision as PushDecision,
      decidedAt: v.decidedAt,
      ...(v.note !== undefined ? { note: v.note } : {}),
    },
  };
}

/**
 * Pure decision. The push question counts as answered for "approved-by-user" and "declined" on
 * the migration branch. Anything else (missing, malformed, other branch, "unresolved") blocks.
 */
export function decideMigrationGate(facts: MigrationGateFacts): MigrationGateDecision {
  const blockers: MigrationBlocker[] = [];

  const d = facts.decision;
  if (d.status === "missing") {
    blockers.push({
      code: "push-decision-unresolved",
      path: d.path,
      detail: `push decision for ${MIGRATION_BRANCH} is unresolved: decision file does not exist`,
    });
  } else if (d.status === "invalid") {
    blockers.push({
      code: "push-decision-unresolved",
      path: d.path,
      detail: `push decision for ${MIGRATION_BRANCH} is unresolved: decision file is invalid (${d.reason})`,
    });
  } else if (d.file.branch !== MIGRATION_BRANCH) {
    blockers.push({
      code: "push-decision-unresolved",
      path: d.path,
      detail: `push decision for ${MIGRATION_BRANCH} is unresolved: decision file is for branch ${d.file.branch}`,
    });
  } else if (d.file.pushDecision === "unresolved") {
    blockers.push({
      code: "push-decision-unresolved",
      path: d.path,
      detail: `push decision for ${MIGRATION_BRANCH} is unresolved: the user has not answered the push question`,
    });
  }

  if (!facts.designSpec.exists) {
    blockers.push({
      code: "design-spec-missing",
      path: facts.designSpec.path,
      detail:
        "Design_Spec (DESIGN.md) does not exist (run `friday design refs`, then `friday design spec`)",
    });
  }
  if (!facts.tokenFile.exists) {
    blockers.push({
      code: "token-file-missing",
      path: facts.tokenFile.path,
      detail:
        "Token_File (tokens.json) does not exist (create it, then run `friday design tokens build`)",
    });
  }

  return blockers.length === 0 ? { ok: true, blockers: [] } : { ok: false, blockers };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readDecision(decisionPath: string, io: MigrationGateIo): Promise<DecisionFacts> {
  let raw: string | undefined;
  try {
    raw = await io.readFile(decisionPath);
  } catch (error) {
    return {
      status: "invalid",
      path: decisionPath,
      reason: `cannot read: ${errorMessage(error)}`,
    };
  }
  if (raw === undefined) {
    return { status: "missing", path: decisionPath };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      path: decisionPath,
      reason: `invalid JSON: ${errorMessage(error)}`,
    };
  }
  const parsed = parseDecisionFile(json);
  return parsed.ok
    ? { status: "present", path: decisionPath, file: parsed.file }
    : { status: "invalid", path: decisionPath, reason: parsed.reason };
}

/** Reads the decision file, DESIGN.md and tokens.json. Writes nothing. */
export async function gatherMigrationFacts(
  options: MigrationGateOptions,
  io: MigrationGateIo,
): Promise<MigrationGateFacts> {
  const paths = resolveDesignPaths(options.workspaceDir, options.designDir);
  const decisionPath = resolveMigrationDecisionPath(options);

  const decision = await readDecision(decisionPath, io);

  const safeExists = async (p: string): Promise<boolean> => {
    try {
      return await io.fileExists(p);
    } catch {
      // An unreadable file cannot be used for migration, so it counts as missing.
      return false;
    }
  };
  return {
    decision,
    designSpec: { path: paths.designSpec, exists: await safeExists(paths.designSpec) },
    tokenFile: { path: paths.tokens, exists: await safeExists(paths.tokens) },
  };
}

/** Gathers the facts and decides. */
export async function runMigrationGate(
  options: MigrationGateOptions,
  io: MigrationGateIo,
): Promise<MigrationGateDecision> {
  return decideMigrationGate(await gatherMigrationFacts(options, io));
}

/** Human-readable report. A refusing gate names each blocking condition exactly. */
export function formatMigrationGateReport(decision: MigrationGateDecision): string[] {
  if (decision.ok) {
    return [
      `Migration gate passed: push decision for ${MIGRATION_BRANCH} is answered, and DESIGN.md and tokens.json exist.`,
    ];
  }
  const lines = [
    "Migration gate REFUSED: the HUD migration did not start and HUD source is unchanged.",
  ];
  for (const b of decision.blockers) {
    lines.push(`  - [${b.code}] ${b.path}: ${b.detail}`);
  }
  return lines;
}

export interface RecordDecisionDeps {
  /** Atomically replaces `filePath` with `content`. Defaults to temp file, fsync, rename. */
  writeAtomic?: (filePath: string, content: string) => Promise<void>;
  now?: () => Date;
}

async function writeAtomicOnDisk(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, filePath);
  } catch (error) {
    // Remove only our own temp file; the target is untouched before the rename.
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * Records the user's answer to the push question. This only writes the decision file; it never
 * runs git. Returns the file that was written.
 */
export async function recordPushDecision(
  options: MigrationGateOptions,
  pushDecision: PushDecision,
  extra: { note?: string; branch?: string } = {},
  deps: RecordDecisionDeps = {},
): Promise<{ path: string; file: MigrationDecisionFile }> {
  if (!PUSH_DECISIONS.includes(pushDecision)) {
    throw new Error(`pushDecision must be one of ${PUSH_DECISIONS.join(", ")}`);
  }
  const file: MigrationDecisionFile = {
    version: 1,
    branch: extra.branch ?? MIGRATION_BRANCH,
    pushDecision,
    decidedAt: (deps.now ?? (() => new Date()))().toISOString(),
    ...(extra.note ? { note: extra.note } : {}),
  };
  const filePath = resolveMigrationDecisionPath(options);
  await (deps.writeAtomic ?? writeAtomicOnDisk)(filePath, `${JSON.stringify(file, null, 2)}\n`);
  return { path: filePath, file };
}
