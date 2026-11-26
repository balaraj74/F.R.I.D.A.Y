import { describe, expect, it } from "vitest";
import {
  EVAL_RECORD_DEADLINE_MS,
  runEvalSuite,
  type EvalScenario,
} from "../../src/jobs/evals/suite.js";
import { evalScenarios, scenarioKinds } from "./scenarios.js";

describe("Eval_Suite scenarios (mocked models)", () => {
  it("covers coding, research and operations with at least 3 scenarios", () => {
    expect(evalScenarios.length).toBeGreaterThanOrEqual(3);
    expect([...scenarioKinds(evalScenarios)].sort()).toEqual(["coding", "operations", "research"]);
  });

  it("passes every scenario and records the deciding Evidence within 5s", async () => {
    const report = await runEvalSuite(evalScenarios);
    expect(report.failed).toBe(0);
    for (const r of report.results) {
      expect(r.pass, `${r.id}: ${r.reason}`).toBe(true);
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.recordLatencyMs).toBeLessThanOrEqual(EVAL_RECORD_DEADLINE_MS);
      expect(r.recordedWithinDeadline).toBe(true);
    }
  });

  it("records the Evidence that decided a failing scenario", async () => {
    const bad: EvalScenario = {
      ...evalScenarios[0]!,
      id: "bad",
      run: async () => ({
        pass: false,
        evidence: [{ checkType: "tests_pass", evidence: { exitCode: 1 } }],
        reason: "tests failed",
      }),
    };
    const { results } = await runEvalSuite([bad]);
    expect(results[0]).toMatchObject({ pass: false, reason: "tests failed", timedOut: false });
    expect(results[0]?.evidence).toHaveLength(1);
  });

  it("stops a scenario that does not finish, records a timeout failure and continues", async () => {
    const aborted: boolean[] = [];
    const hang: EvalScenario = {
      id: "hang",
      kind: "operations",
      run: ({ signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => aborted.push(true));
        }),
    };
    const report = await runEvalSuite([hang, ...evalScenarios], { timeoutMs: 25 });
    const [first, ...rest] = report.results;
    expect(first).toMatchObject({ id: "hang", pass: false, timedOut: true });
    expect(first?.reason).toMatch(/timeout/);
    expect(aborted).toEqual([true]);
    expect(rest).toHaveLength(evalScenarios.length);
    expect(rest.every((r) => r.pass)).toBe(true);
  });

  it("records a thrown scenario as a failure and keeps going", async () => {
    const boom: EvalScenario = {
      id: "boom",
      kind: "coding",
      run: async () => {
        throw new Error("exploded");
      },
    };
    const report = await runEvalSuite([boom, evalScenarios[0]!]);
    expect(report.results[0]).toMatchObject({ pass: false });
    expect(report.results[0]?.reason).toContain("exploded");
    expect(report.results[1]?.pass).toBe(true);
  });

  it("flags a slow recording sink without losing the result", async () => {
    let t = 0;
    const slow: EvalScenario = {
      id: "slow-record",
      kind: "coding",
      run: async () => ({ pass: true, evidence: ["e"] }),
    };
    const report = await runEvalSuite([slow], {
      now: () => (t += 6_000),
      onResult: () => {
        throw new Error("sink down");
      },
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.recordedWithinDeadline).toBe(false);
    expect(report.recordErrors).toEqual([{ id: "slow-record", error: "sink down" }]);
  });
});
