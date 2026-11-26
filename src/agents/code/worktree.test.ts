import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectTestCommand,
  listTasks,
  mergeTask,
  removeTask,
  reviewTask,
  runTests,
  startTask,
} from "./worktree.js";

let root: string;
let repo: string;
let ws: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf-8",
  }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "code-"));
  repo = path.join(root, "careerlens");
  ws = path.join(root, "ws");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.txt"), "v1\n");
  fs.writeFileSync(path.join(repo, "Makefile"), "test:\n\tgrep -q v2 app.txt\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // Sir's own uncommitted work must survive everything.
  fs.writeFileSync(path.join(repo, "notes.txt"), "mine\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("coding tasks", () => {
  it("works on its own branch without touching Sir's checkout", async () => {
    const task = await startTask({ workspaceDir: ws, repo, task: "Bump app to v2!" });
    expect(task).toMatchObject({
      id: "careerlens-bump-app-to-v2",
      branch: "friday/bump-app-to-v2",
      base: "main",
    });
    expect(task.dir.startsWith(ws)).toBe(true);
    expect(detectTestCommand(task.dir)).toEqual(["make", "test"]);
    expect((await runTests(task)).passed).toBe(false);
    fs.writeFileSync(path.join(task.dir, "app.txt"), "v2\n");
    expect((await runTests(task)).passed).toBe(true);
    const review = await reviewTask(task, "Bump to v2");
    expect(review.stat).toContain("app.txt");
    expect(review.diff).toContain("+v2");
    expect(review.commits).toContain("Bump to v2");
    // Sir's checkout: same branch, same file, his notes still there.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(fs.readFileSync(path.join(repo, "app.txt"), "utf-8")).toBe("v1\n");
    expect(fs.readFileSync(path.join(repo, "notes.txt"), "utf-8")).toBe("mine\n");
  });

  it("merges into the starting branch only when it's clean, then tidies up", async () => {
    const task = await startTask({ workspaceDir: ws, repo, task: "v2" });
    fs.writeFileSync(path.join(task.dir, "app.txt"), "v2\n");
    fs.writeFileSync(path.join(repo, "app.txt"), "local edit\n");
    await expect(mergeTask(ws, task)).rejects.toThrow(/uncommitted changes/);
    git(repo, "checkout", "--", "app.txt");
    await mergeTask(ws, task);
    expect(fs.readFileSync(path.join(repo, "app.txt"), "utf-8")).toBe("v2\n");
    expect(fs.existsSync(task.dir)).toBe(false);
    expect(listTasks(ws)).toEqual([]);
    expect(git(repo, "branch", "--list", "friday/v2")).toContain("friday/v2"); // kept in history
  });

  it("discards a task completely and gives repeated tasks unique names", async () => {
    const a = await startTask({ workspaceDir: ws, repo, task: "fix" });
    const b = await startTask({ workspaceDir: ws, repo, task: "fix" });
    expect(b.id).toBe("careerlens-fix-2");
    await removeTask(ws, a);
    expect(git(repo, "branch", "--list", a.branch)).toBe("");
    expect(listTasks(ws).map((t) => t.id)).toEqual([b.id]);
    await expect(startTask({ workspaceDir: ws, repo: root, task: "x" })).rejects.toThrow(
      /isn't a git repository/,
    );
  });
});
