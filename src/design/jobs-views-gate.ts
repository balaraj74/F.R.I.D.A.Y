// Jobs_Views build gate (Requirements 15.6 and 15.7).
//
// Jobs_Views work may start only when the Token_File (with its generated outputs) and the
// Visual_Regression_Harness (config plus passing tests) are complete. This module is read-only:
// `IoGate` has no write method, so a halted gate cannot change any file.
//
// Layout: `gatherFacts` does the IO, `decideGate` is the pure decision, `formatGateReport` renders it.

import path from "node:path";
import { generateOutputs, validateTokenFile } from "./tokens/index.js";
import { resolveDesignPaths } from "./paths.js";

/** Harness config, relative to the workspace root. Task 17.5 appends Jobs_Views screens here. */
export const HARNESS_CONFIG_RELATIVE_PATH = "src/design/visual-regression/config.ts";

/** Result of running the Visual_Regression_Harness test suite. */
export interface HarnessTestRun {
  passed: boolean;
  /** Tail of the runner output, shown when the tests fail. */
  output: string;
}

export interface JobsViewsGateIo {
  /** File content, or `undefined` when the file does not exist. Throws on any other read error. */
  readFile(filePath: string): Promise<string | undefined>;
  /** Runs the Visual_Regression_Harness Vitest tests. A throw is reported as a failed run. */
  runHarnessTests(): Promise<HarnessTestRun>;
}

export interface JobsViewsGateOptions {
  workspaceDir: string;
  /** Overrides `<workspaceDir>/design`. */
  designDir?: string;
}

/** What the gate observed. Produced by `gatherFacts`, consumed by `decideGate`. */
export interface GateFacts {
  tokenFile: { path: string } & (
    | { status: "missing" }
    | { status: "invalid"; errors: string[] }
    | { status: "valid" }
  );
  /** One entry per generated output, in a fixed order. `stale` means it differs from what the Token_File generates. */
  outputs: Array<{ path: string; status: "missing" | "stale" | "current" | "unchecked" }>;
  harness: {
    configPath: string;
    configPresent: boolean;
    tests: { status: "not-run" } | { status: "passed" } | { status: "failed"; detail: string };
  };
}

export type MissingDependencyCode =
  | "token-file-missing"
  | "token-file-invalid"
  | "token-output-missing"
  | "token-output-stale"
  | "harness-config-missing"
  | "harness-tests-failed";

export interface MissingDependency {
  code: MissingDependencyCode;
  /** Spec term of the incomplete dependency. */
  dependency: "Token_File" | "Visual_Regression_Harness";
  /** File that is missing or invalid, when there is one. */
  path?: string;
  detail: string;
}

export type GateDecision = { ok: true; missing: [] } | { ok: false; missing: MissingDependency[] };

const MAX_REPORTED_ERRORS = 5;
const MAX_TEST_OUTPUT_CHARS = 2000;

/** Pure decision: the gate passes only when `missing` is empty. */
export function decideGate(facts: GateFacts): GateDecision {
  const missing: MissingDependency[] = [];

  const tf = facts.tokenFile;
  if (tf.status === "missing") {
    missing.push({
      code: "token-file-missing",
      dependency: "Token_File",
      path: tf.path,
      detail: "Token_File does not exist",
    });
  } else if (tf.status === "invalid") {
    const shown = tf.errors.slice(0, MAX_REPORTED_ERRORS).join("; ");
    const more = tf.errors.length - MAX_REPORTED_ERRORS;
    missing.push({
      code: "token-file-invalid",
      dependency: "Token_File",
      path: tf.path,
      detail: `Token_File fails validation: ${shown}${more > 0 ? ` (+${more} more)` : ""}`,
    });
  }

  for (const output of facts.outputs) {
    if (output.status === "missing") {
      missing.push({
        code: "token-output-missing",
        dependency: "Token_File",
        path: output.path,
        detail: "generated token output does not exist (run `friday design tokens build`)",
      });
    } else if (output.status === "stale") {
      missing.push({
        code: "token-output-stale",
        dependency: "Token_File",
        path: output.path,
        detail:
          "generated token output differs from the Token_File (run `friday design tokens build`)",
      });
    }
  }

  if (!facts.harness.configPresent) {
    missing.push({
      code: "harness-config-missing",
      dependency: "Visual_Regression_Harness",
      path: facts.harness.configPath,
      detail: "Visual_Regression_Harness config does not exist",
    });
  } else if (facts.harness.tests.status === "failed") {
    missing.push({
      code: "harness-tests-failed",
      dependency: "Visual_Regression_Harness",
      detail: `Visual_Regression_Harness tests fail: ${facts.harness.tests.detail}`,
    });
  }

  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectTokens(
  paths: ReturnType<typeof resolveDesignPaths>,
  io: JobsViewsGateIo,
): Promise<Pick<GateFacts, "tokenFile" | "outputs">> {
  const outputPaths = [paths.tokensCss, paths.tailwindTokens];
  // Without a valid Token_File the expected content is unknown, so only existence is checked.
  const unchecked = async (): Promise<GateFacts["outputs"]> =>
    Promise.all(
      outputPaths.map(async (p) => {
        let status: "missing" | "unchecked" = "unchecked";
        try {
          if ((await io.readFile(p)) === undefined) {
            status = "missing";
          }
        } catch {
          // Unreadable: leave unchecked; the Token_File problem is reported anyway.
        }
        return { path: p, status };
      }),
    );

  let raw: string | undefined;
  try {
    raw = await io.readFile(paths.tokens);
  } catch (error) {
    return {
      tokenFile: {
        path: paths.tokens,
        status: "invalid",
        errors: [`cannot read: ${describeError(error)}`],
      },
      outputs: await unchecked(),
    };
  }
  if (raw === undefined) {
    return { tokenFile: { path: paths.tokens, status: "missing" }, outputs: await unchecked() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      tokenFile: {
        path: paths.tokens,
        status: "invalid",
        errors: [`invalid JSON: ${describeError(error)}`],
      },
      outputs: await unchecked(),
    };
  }
  const validation = validateTokenFile(parsed);
  if (!validation.ok) {
    return {
      tokenFile: {
        path: paths.tokens,
        status: "invalid",
        errors: validation.errors.map((e) => `${e.path || "/"}: ${e.reason}`),
      },
      outputs: await unchecked(),
    };
  }

  const expected = generateOutputs(validation.tokens);
  const pairs: Array<[string, string]> = [
    [paths.tokensCss, expected.css],
    [paths.tailwindTokens, expected.tailwind],
  ];
  const outputs: GateFacts["outputs"] = [];
  for (const [outputPath, expectedContent] of pairs) {
    let actual: string | undefined;
    try {
      actual = await io.readFile(outputPath);
    } catch {
      // An unreadable output cannot be used to build views, so it counts as stale.
      outputs.push({ path: outputPath, status: "stale" });
      continue;
    }
    outputs.push({
      path: outputPath,
      status: actual === undefined ? "missing" : actual === expectedContent ? "current" : "stale",
    });
  }
  return { tokenFile: { path: paths.tokens, status: "valid" }, outputs };
}

/** Reads the Token_File, its outputs and the harness state. Writes nothing. */
export async function gatherFacts(
  options: JobsViewsGateOptions,
  io: JobsViewsGateIo,
): Promise<GateFacts> {
  const paths = resolveDesignPaths(options.workspaceDir, options.designDir);
  const tokens = await inspectTokens(paths, io);

  const configPath = path.join(options.workspaceDir, HARNESS_CONFIG_RELATIVE_PATH);
  let configPresent = false;
  let configReadError: string | undefined;
  try {
    configPresent = (await io.readFile(configPath)) !== undefined;
  } catch (error) {
    configReadError = describeError(error);
  }

  let tests: GateFacts["harness"]["tests"] = { status: "not-run" };
  if (configReadError !== undefined) {
    // Present but unreadable: the harness cannot be trusted, so treat the config as missing.
    configPresent = false;
  } else if (configPresent) {
    try {
      const run = await io.runHarnessTests();
      tests = run.passed
        ? { status: "passed" }
        : {
            status: "failed",
            detail: run.output.trim().slice(-MAX_TEST_OUTPUT_CHARS) || "no output",
          };
    } catch (error) {
      tests = { status: "failed", detail: `could not run tests: ${describeError(error)}` };
    }
  }

  return { ...tokens, harness: { configPath, configPresent, tests } };
}

/** Gathers the facts and decides. */
export async function runJobsViewsGate(
  options: JobsViewsGateOptions,
  io: JobsViewsGateIo,
): Promise<GateDecision> {
  return decideGate(await gatherFacts(options, io));
}

/** Human-readable report. Lines for a halted gate name each incomplete dependency exactly. */
export function formatGateReport(decision: GateDecision): string[] {
  if (decision.ok) {
    return [
      "Jobs_Views gate passed: Token_File, generated outputs and Visual_Regression_Harness are complete.",
    ];
  }
  const lines = [
    "Jobs_Views gate HALTED: an upstream dependency is incomplete. No files were changed.",
  ];
  for (const item of decision.missing) {
    lines.push(`  - [${item.dependency}] ${item.path ? `${item.path}: ` : ""}${item.detail}`);
  }
  return lines;
}
