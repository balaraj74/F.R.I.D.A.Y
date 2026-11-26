import { describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  isWriteAllowed,
  planMergeOrder,
  verifyOutcome,
  worktreePath,
  WriteDeniedError,
} from "./logic.js";

describe("worktreePath", () => {
  it("is deterministic and unique per job/task pair", () => {
    expect(worktreePath("j1", "t1")).toBe(worktreePath("j1", "t1"));
    expect(worktreePath("j1", "t1")).not.toBe(worktreePath("j1", "t2"));
    expect(worktreePath("a/b", "c")).not.toBe(worktreePath("a", "b/c"));
  });

  it("keeps hostile ids inside the root", () => {
    const p = worktreePath("..", "../x", "root");
    expect(p.startsWith("root/")).toBe(true);
    expect(p).not.toContain("..");
  });

  it("rejects empty ids", () => {
    expect(() => worktreePath("", "t")).toThrow();
    expect(() => worktreePath("j", "")).toThrow();
  });
});

describe("verifyOutcome", () => {
  it("merges when tests and lint pass", () => {
    expect(verifyOutcome(true, true, 1)).toBe("merge");
    expect(verifyOutcome(true, true, 3)).toBe("merge");
  });

  it("retries a failing attempt while attempts remain", () => {
    expect(verifyOutcome(false, true, 1)).toBe("retry");
    expect(verifyOutcome(true, false, 2)).toBe("retry");
  });

  it("fails after the third failed attempt", () => {
    expect(verifyOutcome(false, false, 3)).toBe("failed");
  });
});

describe("planMergeOrder", () => {
  it("orders dependencies first and keeps input order otherwise", () => {
    const order = planMergeOrder([
      { id: "c", dependsOn: ["b"] },
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "d", dependsOn: [] },
    ]);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores dependencies that are not done and duplicate ids", () => {
    expect(
      planMergeOrder([
        { id: "x", dependsOn: ["missing"] },
        { id: "x", dependsOn: [] },
      ]),
    ).toEqual(["x"]);
  });

  it("throws on a dependency cycle", () => {
    expect(() =>
      planMergeOrder([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]),
    ).toThrow(/Cyclic/);
  });
});

describe("write guard", () => {
  const scope = {
    repoRoot: "/repo",
    worktree: worktreePath("j", "t"),
    declaredPaths: ["docs/out", "/repo/README.md"],
  };

  it("allows writes inside the worktree and declared paths", () => {
    expect(isWriteAllowed("src/a.ts", scope)).toBe(true);
    expect(isWriteAllowed("/repo/.friday/worktrees/j/t/src/a.ts", scope)).toBe(true);
    expect(isWriteAllowed("/repo/docs/out/report.md", scope)).toBe(true);
    expect(isWriteAllowed("/repo/README.md", scope)).toBe(true);
  });

  it("denies writes outside, including traversal and sibling-prefix paths", () => {
    expect(isWriteAllowed("../other/file", scope)).toBe(false);
    expect(isWriteAllowed("/repo/src/a.ts", scope)).toBe(false);
    expect(isWriteAllowed("/repo/docs/out-evil/x", scope)).toBe(false);
    expect(isWriteAllowed("/home/user/.ssh/id_rsa", scope)).toBe(false);
    expect(isWriteAllowed("", scope)).toBe(false);
  });

  it("assertWriteAllowed throws WriteDeniedError when denied", () => {
    expect(() => assertWriteAllowed("/etc/passwd", scope)).toThrow(WriteDeniedError);
    expect(() => assertWriteAllowed("a.txt", scope)).not.toThrow();
  });
});
