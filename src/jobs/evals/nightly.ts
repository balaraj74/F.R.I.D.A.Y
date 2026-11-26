// Nightly report (Requirement 14.9-14.10). Runs the Eval_Suite and Chaos_Suite, stores the run in a
// JSON history, and renders a report with each scenario result and the pass rate of the previous
// 14 runs. A failure is recorded with its cause and keeps the results that already finished.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChaosSuite, type ChaosScenario } from "./chaos.js";
import {
  realSetTimer,
  runEvalSuite,
  type EvalScenario,
  type EvalSuiteOptions,
  type SetTimer,
} from "./suite.js";

/** The report must be produced within this long of the nightly time (14.9). */
export const NIGHTLY_REPORT_BUDGET_MS = 30 * 60_000;
export const NIGHTLY_HISTORY_WINDOW = 14;
export const NIGHTLY_HISTORY_FILE = "nightly-history.json";
export const NIGHTLY_REPORT_FILE = "nightly-report.txt";

export type NightlyScenarioResult = {
  suite: "eval" | "chaos";
  id: string;
  pass: boolean;
  reason?: string;
};

export type NightlyRun = {
  runId: string;
  startedAtMs: number;
  finishedAtMs: number;
  scenarios: NightlyScenarioResult[];
  passRate: number;
  /** Set when the run did not complete; the scenarios that did complete are still listed. */
  error?: string;
};

export type NightlyHistory = { version: 1; runs: NightlyRun[] };

/** Default location of run history: `~/.friday/state/jobs-evals`. Tests pass their own. */
export function defaultNightlyDir(): string {
  return path.join(os.homedir(), ".friday", "state", "jobs-evals");
}

export function passRateOf(scenarios: readonly { pass: boolean }[]): number {
  if (scenarios.length === 0) return 0;
  return scenarios.filter((s) => s.pass).length / scenarios.length;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isRun(v: unknown): v is NightlyRun {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.runId === "string" &&
    typeof r.startedAtMs === "number" &&
    typeof r.passRate === "number" &&
    Array.isArray(r.scenarios)
  );
}

/** Reads the history. A missing file is empty; an unreadable one is reported, not thrown. */
export async function loadNightlyHistory(
  dir: string,
): Promise<{ history: NightlyHistory; warning?: string }> {
  const file = path.join(dir, NIGHTLY_HISTORY_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { history: { version: 1, runs: [] } };
    }
    return {
      history: { version: 1, runs: [] },
      warning: `could not read run history: ${errText(e)}`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as { runs?: unknown };
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isRun) : [];
    return { history: { version: 1, runs } };
  } catch (e) {
    return {
      history: { version: 1, runs: [] },
      warning: `run history is not valid JSON, ignoring it: ${errText(e)}`,
    };
  }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** Previous runs shown in the report: up to 14, oldest first. */
export function previousRuns(history: NightlyHistory, limit = NIGHTLY_HISTORY_WINDOW): NightlyRun[] {
  return history.runs.slice(-limit);
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

export function renderNightlyReport(run: NightlyRun, previous: readonly NightlyRun[]): string {
  const lines: string[] = [];
  lines.push(`FRIDAY nightly report ${run.runId}`);
  lines.push(`Started ${new Date(run.startedAtMs).toISOString()}`);
  lines.push("");
  lines.push("Scenarios");
  if (run.scenarios.length === 0) lines.push("  (none completed)");
  for (const s of run.scenarios) {
    lines.push(
      `  [${s.pass ? "PASS" : "FAIL"}] ${s.suite}/${s.id}${s.reason ? ` - ${s.reason}` : ""}`,
    );
  }
  lines.push(`Pass rate this run: ${pct(run.passRate)}`);
  if (run.error) lines.push("", `ERROR: ${run.error}`);
  lines.push("", `Previous runs (${previous.length}, oldest first)`);
  if (previous.length === 0) lines.push("  (no earlier runs)");
  for (const p of previous) {
    lines.push(
      `  ${new Date(p.startedAtMs).toISOString()} ${p.runId}: ${pct(p.passRate)}${
        p.error ? " (incomplete)" : ""
      }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export type NightlyOptions = {
  /** Where history and the report are stored. Defaults to `defaultNightlyDir()`. */
  dir?: string;
  evalScenarios: readonly EvalScenario[];
  chaosScenarios: readonly ChaosScenario[];
  evalOptions?: EvalSuiteOptions;
  now?: () => number;
  setTimer?: SetTimer;
  /** Time allowed to produce the report. Defaults to 30 minutes. */
  budgetMs?: number;
  runId?: string;
};

export type NightlyResult = {
  run: NightlyRun;
  previous: NightlyRun[];
  report: string;
  historyPath: string;
  reportPath: string;
  /** Problems that did not stop the run, such as an unreadable history file. */
  warnings: string[];
};

export async function runNightly(opts: NightlyOptions): Promise<NightlyResult> {
  const dir = opts.dir ?? defaultNightlyDir();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? realSetTimer;
  const budgetMs = opts.budgetMs ?? NIGHTLY_REPORT_BUDGET_MS;
  const startedAtMs = now();
  const runId = opts.runId ?? new Date(startedAtMs).toISOString().replace(/[:.]/g, "-");
  const warnings: string[] = [];

  const loaded = await loadNightlyHistory(dir);
  if (loaded.warning) warnings.push(loaded.warning);
  const history = loaded.history;

  // Results are pushed as each scenario finishes, so they survive a later failure or timeout.
  const completed: NightlyScenarioResult[] = [];
  let error: string | undefined;

  const work = (async () => {
    await runEvalSuite(opts.evalScenarios, {
      ...opts.evalOptions,
      onResult: async (r) => {
        completed.push({
          suite: "eval",
          id: r.id,
          pass: r.pass,
          ...(r.reason !== undefined ? { reason: r.reason } : {}),
        });
        await opts.evalOptions?.onResult?.(r);
      },
    });
    for (const scenario of opts.chaosScenarios) {
      const [r] = await runChaosSuite([scenario]);
      if (!r) continue;
      completed.push({
        suite: "chaos",
        id: r.id,
        pass: r.pass,
        ...(r.reasons.length > 0 ? { reason: r.reasons.join("; ") } : {}),
      });
    }
  })();

  let budgetTimer: ReturnType<SetTimer> | undefined;
  const overBudget = new Promise<"budget">((resolve) => {
    budgetTimer = setTimer(() => resolve("budget"), budgetMs);
  });
  try {
    const winner = await Promise.race([work.then(() => "done" as const), overBudget]);
    if (winner === "budget") {
      error = `report not produced within ${budgetMs}ms; ${completed.length} scenario(s) completed`;
      work.catch(() => undefined);
    }
  } catch (e) {
    error = `nightly run failed: ${errText(e)}`;
  } finally {
    budgetTimer?.cancel();
  }

  const run: NightlyRun = {
    runId,
    startedAtMs,
    finishedAtMs: now(),
    scenarios: [...completed],
    passRate: passRateOf(completed),
    ...(error !== undefined ? { error } : {}),
  };
  const previous = previousRuns(history);
  const report = renderNightlyReport(run, previous);
  const historyPath = path.join(dir, NIGHTLY_HISTORY_FILE);
  const reportPath = path.join(dir, NIGHTLY_REPORT_FILE);

  // Persisting can fail too (read-only dir, full disk). Record that on the run and still return it.
  try {
    await writeFileAtomic(
      historyPath,
      `${JSON.stringify({ version: 1, runs: [...history.runs, run] } satisfies NightlyHistory, null, 2)}\n`,
    );
    await writeFileAtomic(reportPath, report);
  } catch (e) {
    run.error = [run.error, `could not store history or report: ${errText(e)}`]
      .filter(Boolean)
      .join("; ");
    return {
      run,
      previous,
      report: renderNightlyReport(run, previous),
      historyPath,
      reportPath,
      warnings,
    };
  }
  return { run, previous, report, historyPath, reportPath, warnings };
}
