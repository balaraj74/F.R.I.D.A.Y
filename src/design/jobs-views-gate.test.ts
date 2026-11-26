import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./jobs-views-gate-cli.js";
import {
  HARNESS_CONFIG_RELATIVE_PATH,
  decideGate,
  formatGateReport,
  runJobsViewsGate,
  type HarnessTestRun,
  type JobsViewsGateIo,
} from "./jobs-views-gate.js";
import { resolveDesignPaths } from "./paths.js";
import { generateOutputs, type TokenFile } from "./tokens/index.js";

const ROOT = "/ws";
const paths = resolveDesignPaths(ROOT);
const configPath = path.join(ROOT, HARNESS_CONFIG_RELATIVE_PATH);

const tokens: TokenFile = {
  version: 1,
  color: { ink: "#111111", paper: "#ffffff" },
  type: { body: { size: "16px", weight: 400 } },
  spacing: { "2": "8px" },
  radius: { sm: "4px" },
  elevation: { raised: "0 1px 2px #0003" },
  motion: { fast: "120ms" },
  contrastPairs: [{ text: "ink", background: "paper" }],
};

/** Files of a fully complete workspace. Tests delete or replace entries to break one dependency. */
function completeFiles(): Map<string, string> {
  const out = generateOutputs(tokens);
  return new Map([
    [paths.tokens, JSON.stringify(tokens)],
    [paths.tokensCss, out.css],
    [paths.tailwindTokens, out.tailwind],
    [configPath, "export const SCREENS = [];"],
  ]);
}

function fakeIo(files: Map<string, string>, run: HarnessTestRun | Error) {
  const calls = { reads: [] as string[], testRuns: 0 };
  const io: JobsViewsGateIo = {
    async readFile(filePath) {
      calls.reads.push(filePath);
      return files.get(filePath);
    },
    async runHarnessTests() {
      calls.testRuns++;
      if (run instanceof Error) {
        throw run;
      }
      return run;
    },
  };
  return { io, calls };
}

const PASS: HarnessTestRun = { passed: true, output: "ok" };
const opts = { workspaceDir: ROOT };

describe("Jobs_Views build gate", () => {
  it("passes when tokens, outputs and the harness are complete", async () => {
    const { io, calls } = fakeIo(completeFiles(), PASS);
    const decision = await runJobsViewsGate(opts, io);
    expect(decision).toEqual({ ok: true, missing: [] });
    expect(calls.testRuns).toBe(1);
  });

  it("halts and names the Token_File when it is missing", async () => {
    const files = completeFiles();
    files.delete(paths.tokens);
    const decision = await runJobsViewsGate(opts, fakeIo(files, PASS).io);
    expect(decision.ok).toBe(false);
    expect(decision.missing).toEqual([
      expect.objectContaining({ code: "token-file-missing", path: paths.tokens }),
    ]);
  });

  it("reports every absent file when nothing from the design track exists", async () => {
    const decision = await runJobsViewsGate(opts, fakeIo(new Map(), PASS).io);
    expect(decision.missing.map((m) => [m.code, m.path])).toEqual([
      ["token-file-missing", paths.tokens],
      ["token-output-missing", paths.tokensCss],
      ["token-output-missing", paths.tailwindTokens],
      ["harness-config-missing", configPath],
    ]);
  });

  it("halts with the validation reason when the Token_File is invalid", async () => {
    const files = completeFiles();
    files.set(paths.tokens, JSON.stringify({ ...tokens, radius: {} }));
    const decision = await runJobsViewsGate(opts, fakeIo(files, PASS).io);
    expect(decision.ok).toBe(false);
    expect(decision.missing[0]).toMatchObject({ code: "token-file-invalid", path: paths.tokens });
    expect(decision.missing[0]?.detail).toContain("/radius");
  });

  it("halts when the Token_File is not JSON", async () => {
    const files = completeFiles();
    files.set(paths.tokens, "{not json");
    const decision = await runJobsViewsGate(opts, fakeIo(files, PASS).io);
    expect(decision.missing[0]).toMatchObject({ code: "token-file-invalid" });
    expect(decision.missing[0]?.detail).toContain("invalid JSON");
  });

  it("halts when a generated output is missing", async () => {
    const files = completeFiles();
    files.delete(paths.tailwindTokens);
    const decision = await runJobsViewsGate(opts, fakeIo(files, PASS).io);
    expect(decision.missing).toEqual([
      expect.objectContaining({ code: "token-output-missing", path: paths.tailwindTokens }),
    ]);
  });

  it("halts when a generated output no longer matches the Token_File", async () => {
    const files = completeFiles();
    files.set(paths.tokensCss, ":root {}\n");
    const decision = await runJobsViewsGate(opts, fakeIo(files, PASS).io);
    expect(decision.missing).toEqual([
      expect.objectContaining({ code: "token-output-stale", path: paths.tokensCss }),
    ]);
  });

  it("halts without running tests when the harness config is missing", async () => {
    const files = completeFiles();
    files.delete(configPath);
    const { io, calls } = fakeIo(files, PASS);
    const decision = await runJobsViewsGate(opts, io);
    expect(decision.missing).toEqual([
      expect.objectContaining({ code: "harness-config-missing", path: configPath }),
    ]);
    expect(calls.testRuns).toBe(0);
  });

  it("halts when the harness tests fail, including the runner output", async () => {
    const decision = await runJobsViewsGate(
      opts,
      fakeIo(completeFiles(), { passed: false, output: "FAIL harness.test.ts\n1 failed" }).io,
    );
    expect(decision.missing).toEqual([expect.objectContaining({ code: "harness-tests-failed" })]);
    expect(decision.missing[0]?.detail).toContain("1 failed");
  });

  it("treats a runner that cannot start as failing harness tests", async () => {
    const decision = await runJobsViewsGate(
      opts,
      fakeIo(completeFiles(), new Error("spawn pnpm ENOENT")).io,
    );
    expect(decision.missing[0]).toMatchObject({ code: "harness-tests-failed" });
    expect(decision.missing[0]?.detail).toContain("spawn pnpm ENOENT");
  });

  it("only reads: the IO has no write method", () => {
    const { io } = fakeIo(completeFiles(), PASS);
    expect(Object.keys(io).sort()).toEqual(["readFile", "runHarnessTests"]);
  });

  it("decideGate is pure over the facts", () => {
    const facts = {
      tokenFile: { path: "t", status: "valid" as const },
      outputs: [{ path: "o", status: "current" as const }],
      harness: { configPath: "c", configPresent: true, tests: { status: "passed" as const } },
    };
    expect(decideGate(facts)).toEqual({ ok: true, missing: [] });
    expect(decideGate(facts)).toEqual(decideGate(facts));
  });

  it("formats a halted report naming each dependency", () => {
    const lines = formatGateReport({
      ok: false,
      missing: [
        {
          code: "token-file-missing",
          dependency: "Token_File",
          path: "/x/tokens.json",
          detail: "gone",
        },
      ],
    });
    expect(lines[0]).toContain("HALTED");
    expect(lines[0]).toContain("No files were changed");
    expect(lines[1]).toContain("[Token_File] /x/tokens.json: gone");
  });
});

describe("jobs-views:gate CLI", () => {
  async function run(files: Map<string, string>, testRun: HarnessTestRun, argv: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      cwd: ROOT,
      createIo: () => fakeIo(files, testRun).io,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out, err };
  }

  it("exits 0 when the gate passes", async () => {
    const { code, err } = await run(completeFiles(), PASS);
    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  it("exits non-zero and reports the missing dependency on stderr", async () => {
    const files = completeFiles();
    files.delete(paths.tokens);
    const { code, out, err } = await run(files, PASS);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain(paths.tokens);
  });

  it("exits 64 on an unknown argument", async () => {
    const { code, err } = await run(completeFiles(), PASS, ["--nope"]);
    expect(code).toBe(64);
    expect(err[0]).toContain("unknown argument");
  });
});
