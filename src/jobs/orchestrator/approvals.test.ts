import { describe, expect, it } from "vitest";
import { commandKinds } from "../../infra/autonomy-trust.js";
import { applyFirstDecision, classifyAction, denyOutcome, type TaskDef } from "./index.js";

const task = (id: string, dependsOn: string[] = [], requiresOutputFrom?: string[]): TaskDef => ({
  id,
  role: "builder",
  dependsOn,
  acceptanceChecks: [],
  ...(requiresOutputFrom ? { requiresOutputFrom } : {}),
});

describe("classifyAction", () => {
  it("classifies git push as never-auto with a reason", () => {
    expect(classifyAction("git push")).toEqual({
      neverAuto: true,
      reason: "pushes code to a remote",
    });
  });

  it("classifies a real `git push` command's kinds as never-auto", () => {
    const kinds = commandKinds("git push origin main");
    expect(kinds).toEqual(["git push"]);
    expect(kinds.every((k) => classifyAction(k).neverAuto)).toBe(true);
  });

  it("does not gate ordinary kinds", () => {
    expect(classifyAction("git commit")).toEqual({ neverAuto: false, reason: null });
    expect(classifyAction("pip install")).toEqual({ neverAuto: false, reason: null });
  });
});

describe("applyFirstDecision", () => {
  it("returns null when there are no decisions", () => {
    expect(applyFirstDecision([])).toBeNull();
  });

  it("picks the earliest by `at`, regardless of input order", () => {
    expect(
      applyFirstDecision([
        { at: 30, decision: "approve" },
        { at: 10, decision: "deny" },
        { at: 20, decision: "approve" },
      ]),
    ).toEqual({ at: 10, decision: "deny" });
  });

  it("breaks ties by input order", () => {
    expect(
      applyFirstDecision([
        { at: 5, decision: "deny" },
        { at: 5, decision: "approve" },
      ]),
    ).toEqual({ at: 5, decision: "deny" });
  });
});

describe("denyOutcome", () => {
  it("skips when there are no dependents", () => {
    expect(denyOutcome("a", [task("a")], {})).toBe("skipped");
  });

  it("skips when dependents do not require the output", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"])];
    expect(denyOutcome("a", tasks, {})).toBe("skipped");
  });

  it("fails when a direct dependent requires the output", () => {
    const tasks = [task("a"), task("b", ["a"], ["a"])];
    expect(denyOutcome("a", tasks, {})).toBe("failed");
  });

  it("fails when a transitive dependent requires the output", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["b"], ["a"])];
    expect(denyOutcome("a", tasks, {})).toBe("failed");
  });

  it("ignores requirements on other Tasks and on non-dependents", () => {
    const tasks = [task("a"), task("x"), task("b", ["a", "x"], ["x"]), task("y", ["x"], ["a"])];
    expect(denyOutcome("a", tasks, {})).toBe("skipped");
  });
});
