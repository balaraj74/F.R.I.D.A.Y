import { describe, expect, it } from "vitest";
import {
  ROLE_TOOL_ALLOWLIST,
  evaluateCheck,
  isToolAllowed,
  readyTasks,
  schedule,
  taskVerificationOutcome,
  validatePlan,
  type TaskDef,
} from "./index.js";

const task = (id: string, dependsOn: string[] = [], checks = 1): TaskDef => ({
  id,
  role: "builder",
  dependsOn,
  acceptanceChecks: Array.from({ length: checks }, () => ({
    type: "file_exists" as const,
    path: "a.txt",
  })),
});

describe("validatePlan", () => {
  it("accepts a valid dependency graph", () => {
    expect(validatePlan([task("a"), task("b", ["a"]), task("c", ["a", "b"])])).toEqual({
      ok: true,
    });
  });

  it("rejects empty plans, duplicates, self and unknown dependencies, and bad check counts", () => {
    expect(validatePlan([]).ok).toBe(false);
    const result = validatePlan([
      task("a", ["a"]),
      task("a"),
      task("b", ["zzz"], 0),
      task("c", [], 11),
    ]);
    expect(result.ok).toBe(false);
    const text = result.ok ? "" : result.errors.join("\n");
    expect(text).toContain("task a: duplicate id");
    expect(text).toContain("task a: depends on itself");
    expect(text).toContain("task b: depends on unknown task zzz");
    expect(text).toContain("task b: must have 1-10");
    expect(text).toContain("task c: must have 1-10");
  });

  it("rejects more than 50 tasks", () => {
    const tasks = Array.from({ length: 51 }, (_, i) => task(`t${i}`));
    expect(validatePlan(tasks).ok).toBe(false);
  });

  it("names only the tasks on a cycle", () => {
    const result = validatePlan([task("a", ["b"]), task("b", ["a"]), task("c", ["a"])]);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).not.toContain("task c");
  });
});

describe("roles", () => {
  it("allows only listed tools", () => {
    expect(isToolAllowed("reviewer", "read")).toBe(true);
    expect(isToolAllowed("reviewer", "exec")).toBe(false);
    expect(isToolAllowed("builder", "toString")).toBe(false);
    for (const [role, tools] of Object.entries(ROLE_TOOL_ALLOWLIST)) {
      expect(new Set(tools).size, role).toBe(tools.length);
    }
  });
});

describe("scheduling", () => {
  it("returns only tasks whose dependencies are done", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c"), task("d", ["c"])];
    expect(readyTasks(tasks, { a: "done", c: "running" })).toEqual(["b"]);
    expect(readyTasks(tasks, {})).toEqual(["a", "c"]);
    expect(readyTasks(tasks, { a: "failed" })).toEqual(["c"]);
  });

  it("fills only the free slots and rejects an out-of-range limit", () => {
    expect(schedule(["a", "b", "c"], 1, 2)).toEqual(["a"]);
    expect(schedule(["a"], 5, 2)).toEqual([]);
    expect(() => schedule(["a"], 0, 0)).toThrow(RangeError);
    expect(() => schedule(["a"], 0, 17)).toThrow(RangeError);
  });
});

describe("verification", () => {
  it("evaluates each check type", () => {
    expect(
      evaluateCheck({ type: "tests_pass", command: "t" }, { type: "tests_pass", exitCode: 0 }),
    ).toBe("pass");
    expect(
      evaluateCheck({ type: "tests_pass", command: "t" }, { type: "tests_pass", exitCode: 1 }),
    ).toBe("fail");
    expect(
      evaluateCheck(
        { type: "exit_code", command: "c", expected: 3 },
        { type: "exit_code", exitCode: 3 },
      ),
    ).toBe("pass");
    expect(
      evaluateCheck({ type: "file_exists", path: "p" }, { type: "file_exists", exists: false }),
    ).toBe("fail");
    expect(
      evaluateCheck({ type: "rubric", items: ["x", "y"] }, { type: "rubric", metItems: ["x"] }),
    ).toBe("fail");
    expect(
      evaluateCheck({ type: "rubric", items: ["x"] }, { type: "rubric", metItems: ["x"] }),
    ).toBe("pass");
    expect(evaluateCheck({ type: "file_exists", path: "p" })).toBe("no-evidence");
    expect(
      evaluateCheck({ type: "file_exists", path: "p" }, { type: "exit_code", exitCode: 0 }),
    ).toBe("no-evidence");
  });

  it("retries until the third attempt, then fails", () => {
    expect(taskVerificationOutcome(["pass", "pass"], 1)).toBe("done");
    expect(taskVerificationOutcome(["pass", "fail"], 1)).toBe("retry");
    expect(taskVerificationOutcome(["no-evidence"], 2)).toBe("retry");
    expect(taskVerificationOutcome(["fail"], 3)).toBe("failed");
    expect(taskVerificationOutcome([], 3)).toBe("failed");
  });
});
