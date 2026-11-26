// Eval_Suite runner (Requirement 14.1-14.3). A scenario drives the real Orchestrator with mocked
// models and returns whether it passed plus the Evidence that decided it. The runner records each
// result straight away, stops a scenario that runs too long, and carries on with the rest.

/** A scenario that has not finished by now is stopped and recorded as a timeout failure (14.3). */
export const EVAL_SCENARIO_TIMEOUT_MS = 600_000;
/** A result must be recorded within this long of the scenario finishing (14.2). */
export const EVAL_RECORD_DEADLINE_MS = 5_000;

export type ScenarioKind = "coding" | "research" | "operations";

/** What a scenario hands back: the verdict and the Evidence (or observations) behind it. */
export type ScenarioOutcome = {
  pass: boolean;
  evidence: unknown[];
  /** Why the scenario failed, when it did. */
  reason?: string;
};

export type EvalScenario = {
  id: string;
  kind: ScenarioKind;
  /** `signal` aborts when the scenario is stopped for running too long. */
  run(ctx: { signal: AbortSignal }): Promise<ScenarioOutcome>;
};

export type EvalScenarioResult = {
  id: string;
  kind: ScenarioKind;
  pass: boolean;
  /** The Evidence that decided the result. Empty when the scenario never produced any. */
  evidence: unknown[];
  reason?: string;
  timedOut: boolean;
  startedAtMs: number;
  finishedAtMs: number;
  recordedAtMs: number;
  /** `recordedAtMs - finishedAtMs`. */
  recordLatencyMs: number;
  recordedWithinDeadline: boolean;
};

export type TimerHandle = { cancel(): void };
export type SetTimer = (fn: () => void, ms: number) => TimerHandle;

export const realSetTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
};

export type EvalSuiteOptions = {
  /** Per-scenario limit. Injectable so tests need not wait 600s. */
  timeoutMs?: number;
  now?: () => number;
  setTimer?: SetTimer;
  /** Called with every result as soon as it is recorded. A throw is kept in `recordError`. */
  onResult?: (result: EvalScenarioResult) => void | Promise<void>;
};

export type EvalSuiteReport = {
  results: EvalScenarioResult[];
  passed: number;
  failed: number;
  /** Errors thrown by `onResult`, by scenario id. */
  recordErrors: Array<{ id: string; error: string }>;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Settled =
  | { kind: "outcome"; outcome: ScenarioOutcome }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

/** Runs one scenario, giving up after `timeoutMs`. */
async function runWithLimit(
  scenario: EvalScenario,
  timeoutMs: number,
  setTimer: SetTimer,
): Promise<Settled> {
  const controller = new AbortController();
  let timer: TimerHandle | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimer(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const run = (async (): Promise<Settled> => {
    try {
      return { kind: "outcome", outcome: await scenario.run({ signal: controller.signal }) };
    } catch (e) {
      return { kind: "error", message: errText(e) };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    timer?.cancel();
  }
}

export async function runEvalSuite(
  scenarios: readonly EvalScenario[],
  opts: EvalSuiteOptions = {},
): Promise<EvalSuiteReport> {
  const timeoutMs = opts.timeoutMs ?? EVAL_SCENARIO_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? realSetTimer;
  const results: EvalScenarioResult[] = [];
  const recordErrors: EvalSuiteReport["recordErrors"] = [];

  for (const scenario of scenarios) {
    const startedAtMs = now();
    const settled = await runWithLimit(scenario, timeoutMs, setTimer);
    const finishedAtMs = now();

    let pass = false;
    let evidence: unknown[] = [];
    let reason: string | undefined;
    if (settled.kind === "timeout") {
      reason = `timeout: scenario did not finish within ${timeoutMs}ms and was stopped`;
    } else if (settled.kind === "error") {
      reason = `scenario threw: ${settled.message}`;
    } else {
      pass = settled.outcome.pass;
      evidence = settled.outcome.evidence;
      if (!pass) reason = settled.outcome.reason ?? "scenario reported failure";
    }

    // The result is stored before anything slow (the sink) runs, so recording never waits on it.
    const recordedAtMs = now();
    const result: EvalScenarioResult = {
      id: scenario.id,
      kind: scenario.kind,
      pass,
      evidence,
      ...(reason !== undefined ? { reason } : {}),
      timedOut: settled.kind === "timeout",
      startedAtMs,
      finishedAtMs,
      recordedAtMs,
      recordLatencyMs: recordedAtMs - finishedAtMs,
      recordedWithinDeadline: recordedAtMs - finishedAtMs <= EVAL_RECORD_DEADLINE_MS,
    };
    results.push(result);
    try {
      await opts.onResult?.(result);
    } catch (e) {
      recordErrors.push({ id: scenario.id, error: errText(e) });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: results.length - passed, recordErrors };
}
