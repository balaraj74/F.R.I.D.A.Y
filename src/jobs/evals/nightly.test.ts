// Nightly report tests. History lives in a per-test temp dir; nothing touches the user's folders.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChaosScenario } from "./chaos.js";
import {
  NIGHTLY_HISTORY_FILE,
  NIGHTLY_HISTORY_WINDOW,
  defaultNightlyDir,
  loadNightlyHistory,
  passRateOf,
  runNightly,
  type NightlyRun,
} from "./nightly.js";
import type { EvalScenario } from "./suite.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-nightly-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const evalOk = (id: string): EvalScenario => ({
  id,
  kind: "coding",
  run: async () => ({ pass: true, evidence: ["e"] }),
});
const evalBad = (id: string): EvalScenario => ({
  id,
  kind: "research",
  run: async () => ({ pass: false, evidence: ["x"], reason: "nope" }),
});
const chaosOk = (id: string): ChaosScenario => ({
  id,
  fault: "proxy",
  run: async () => ({ faultInjectedAtMs: 0, observedAtMs: 10, state: "done" }),
});

const fakeRun = (n: number, passRate: number): NightlyRun => ({
  runId: `r${n}`,
  startedAtMs: n * 1000,
  finishedAtMs: n * 1000 + 1,
  scenarios: [],
  passRate,
});
async function seed(runs: NightlyRun[]) {
  await fs.writeFile(path.join(dir, NIGHTLY_HISTORY_FILE), JSON.stringify({ version: 1, runs }));
}

describe("runNightly", () => {
  it("lists each scenario result and stores the run", async () => {
    const res = await runNightly({
      dir,
      evalScenarios: [evalOk("e1"), evalBad("e2")],
      chaosScenarios: [chaosOk("c1")],
    });
    expect(res.run.scenarios.map((s) => [s.suite, s.id, s.pass])).toEqual([
      ["eval", "e1", true],
      ["eval", "e2", false],
      ["chaos", "c1", true],
    ]);
    expect(res.run.passRate).toBeCloseTo(2 / 3);
    expect(res.report).toContain("[PASS] eval/e1");
    expect(res.report).toContain("[FAIL] eval/e2 - nope");
    const stored = JSON.parse(await fs.readFile(res.historyPath, "utf8"));
    expect(stored.runs).toHaveLength(1);
    expect(await fs.readFile(res.reportPath, "utf8")).toBe(res.report);
  });

  it("shows the pass rate of only the previous 14 runs", async () => {
    await seed(Array.from({ length: 20 }, (_, i) => fakeRun(i + 1, i / 20)));
    const res = await runNightly({ dir, evalScenarios: [evalOk("e1")], chaosScenarios: [] });
    expect(res.previous).toHaveLength(NIGHTLY_HISTORY_WINDOW);
    expect(res.previous[0]?.runId).toBe("r7");
    expect(res.previous.at(-1)?.runId).toBe("r20");
    expect(res.report).not.toContain("r6:");
    expect(res.report).toContain("r7: 30.0%");
    const stored = JSON.parse(await fs.readFile(res.historyPath, "utf8"));
    expect(stored.runs).toHaveLength(21);
  });

  it("shows all earlier runs when fewer than 14 exist", async () => {
    await seed([fakeRun(1, 1), fakeRun(2, 0.5)]);
    const res = await runNightly({ dir, evalScenarios: [evalOk("e1")], chaosScenarios: [] });
    expect(res.previous.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("says so when there are no earlier runs", async () => {
    const res = await runNightly({ dir, evalScenarios: [evalOk("e1")], chaosScenarios: [] });
    expect(res.previous).toEqual([]);
    expect(res.report).toContain("(no earlier runs)");
  });

  it("records the cause and keeps completed results when the run fails part way", async () => {
    const boom: ChaosScenario = {
      id: "bad-chaos",
      fault: "disk",
      run: async () => {
        throw new Error("harness broke");
      },
    };
    // A chaos scenario that throws is a failed scenario, not a failed run; a stuck one is the failure.
    const stuck: ChaosScenario = { id: "stuck", fault: "network", run: () => new Promise(() => undefined) };
    let fire: (() => void) | undefined;
    const res = await runNightly({
      dir,
      evalScenarios: [evalOk("e1")],
      chaosScenarios: [boom, stuck, chaosOk("never-reached")],
      budgetMs: 1_800_000,
      setTimer: (fn) => {
        fire = fn;
        // Simulates the 30 minute budget running out once the stuck scenario started.
        setTimeout(() => fire?.(), 50);
        return { cancel: () => undefined };
      },
    });
    expect(res.run.error).toContain("not produced within");
    expect(res.run.scenarios.map((s) => s.id)).toEqual(["e1", "bad-chaos"]);
    expect(res.run.scenarios[1]?.pass).toBe(false);
    expect(res.report).toContain("ERROR:");
    const stored = JSON.parse(await fs.readFile(res.historyPath, "utf8"));
    expect(stored.runs[0].scenarios).toHaveLength(2);
  });

  it("reports an error and still returns results when history cannot be written", async () => {
    const blocker = path.join(dir, "file");
    await fs.writeFile(blocker, "x");
    const res = await runNightly({
      dir: path.join(blocker, "sub"),
      evalScenarios: [evalOk("e1")],
      chaosScenarios: [],
    });
    expect(res.run.error).toContain("could not store");
    expect(res.run.scenarios).toHaveLength(1);
    expect(res.report).toContain("ERROR:");
  });

  it("ignores a corrupt history file with a warning", async () => {
    await fs.writeFile(path.join(dir, NIGHTLY_HISTORY_FILE), "{not json");
    const res = await runNightly({ dir, evalScenarios: [evalOk("e1")], chaosScenarios: [] });
    expect(res.warnings.join()).toContain("not valid JSON");
    expect(res.run.scenarios).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("computes pass rates", () => {
    expect(passRateOf([])).toBe(0);
    expect(passRateOf([{ pass: true }, { pass: false }])).toBe(0.5);
  });
  it("defaults history under ~/.friday/state", () => {
    expect(defaultNightlyDir()).toBe(path.join(os.homedir(), ".friday", "state", "jobs-evals"));
  });
  it("loads an absent history as empty", async () => {
    expect((await loadNightlyHistory(dir)).history.runs).toEqual([]);
  });
});
