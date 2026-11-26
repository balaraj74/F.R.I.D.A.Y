// Integration tests for the worktree manager against real, scripted git repositories
// (Requirements 9.1, 9.2, 9.4, 9.7, 9.10, 9.11). Each test builds a repository in a directory
// from `mkdtemp` under the OS temp dir and removes only that directory afterwards.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorktreeManager, type WorktreeManager } from "./manager.js";
import type { CommandSpec, WorktreeManagerDeps } from "./manager-types.js";
import { jobBranchName, taskBranchName } from "./names.js";

const PASS: CommandSpec = { file: "node", args: ["-e", "process.exit(0)"] };
const HANG: CommandSpec = { file: "node", args: ["-e", "setTimeout(() => {}, 60000)"] };

/** Temp directories created by these tests, and the only ones they remove. */
const created: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository on branch `main` with one commit containing `shared.txt`. */
async function scriptedRepo(): Promise<{ repo: string; baseSha: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-worktree-it-"));
  created.push(dir);
  const repo = await fs.realpath(dir);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(repo, "shared.txt"), "line 1\nline 2\nline 3\n");
  git(repo, "add", "shared.txt");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, baseSha: git(repo, "rev-parse", "HEAD").trim() };
}

function manager(repo: string, extra: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return createWorktreeManager({
    repoRoot: repo,
    testCommand: PASS,
    lintCommand: PASS,
    ...extra,
  });
}

const tip = (repo: string, branch: string) => git(repo, "rev-parse", `refs/heads/${branch}`).trim();
const branches = (repo: string) =>
  git(repo, "branch", "--list", "--format=%(refname:short)").split("\n").filter(Boolean);

async function newTask(m: WorktreeManager, taskId: string): Promise<string> {
  const res = await m.createTaskWorktree({ jobId: "j1", taskId });
  if (!res.ok) throw new Error(res.reason);
  return res.path;
}

/** Writes a file in a Task's worktree. Merging snapshots it, so no commit is needed here. */
async function edit(worktree: string, file: string, text: string): Promise<void> {
  await fs.writeFile(path.join(worktree, file), text);
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    // Only directories made by `scriptedRepo` are in this list.
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("worktree manager with real git", () => {
  it("merges a Task that passes tests and lint into the Job_Branch (Req 9.3, 9.5)", async () => {
    const { repo } = await scriptedRepo();
    const m = manager(repo);
    const wt = await newTask(m, "t1");
    expect(wt).toBe(path.join(repo, ".friday", "worktrees", "j1", "t1"));
    await edit(wt, "feature.txt", "hello\n");

    const res = await m.verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });

    expect(res.verification.decision).toBe("merge");
    expect(res.merge?.status).toBe("merged");
    expect(git(repo, "show", `${jobBranchName("j1")}:feature.txt`)).toBe("hello\n");
    // The user's branch is untouched.
    expect(git(repo, "show", "main:shared.txt")).toBe("line 1\nline 2\nline 3\n");
    expect(() => git(repo, "show", "main:feature.txt")).toThrow();
  });

  it("aborts a same-file conflict, reconciles, and merges only after re-verification (Req 9.7)", async () => {
    const { repo } = await scriptedRepo();
    const m = manager(repo);
    const w1 = await newTask(m, "t1");
    const w2 = await newTask(m, "t2");
    await edit(w1, "shared.txt", "line 1\nfrom t1\nline 3\n");
    await edit(w2, "shared.txt", "line 1\nfrom t2\nline 3\n");

    const first = await m.verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(first.merge?.status).toBe("merged");
    const jobTipAfterFirst = tip(repo, jobBranchName("j1"));

    const second = await m.verifyAndMerge({ jobId: "j1", taskId: "t2", attempt: 1 });
    expect(second.verification.decision).toBe("merge");
    expect(second.merge).toMatchObject({
      status: "conflict",
      jobBranchUnchanged: true,
      files: ["shared.txt"],
      reconcile: { conflictingTaskId: "t2", conflictingBranch: taskBranchName("j1", "t2") },
    });
    // The merge was aborted: the Job_Branch is where it was and its checkout is clean.
    expect(tip(repo, jobBranchName("j1"))).toBe(jobTipAfterFirst);
    const integration = path.join(repo, ".friday", "worktrees", "j1", "%integration");
    expect(git(integration, "status", "--porcelain").trim()).toBe("");
    expect(() => git(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    // The conflicting Task cannot merge again without being verified again.
    expect(await m.mergeTask({ jobId: "j1", taskId: "t2" })).toMatchObject({
      status: "not_verified",
    });

    // A reconcile Task resolves the conflict in its own worktree, then goes through verification.
    const rec = await m.beginReconcile({
      jobId: "j1",
      reconcileTaskId: "r1",
      conflictingTaskId: "t2",
    });
    expect(rec).toMatchObject({ ok: true, conflictFiles: ["shared.txt"] });
    if (!rec.ok) return;
    await edit(rec.path, "shared.txt", "line 1\nfrom t1 and t2\nline 3\n");
    // Marking the file resolved is part of the reconcile Task's work; verification refuses
    // to commit while the index still holds conflict entries.
    git(rec.path, "add", "shared.txt");
    const reconciled = await m.verifyAndMerge({ jobId: "j1", taskId: "r1", attempt: 1 });
    expect(reconciled.verification.decision).toBe("merge");
    expect(reconciled.merge?.status).toBe("merged");
    expect(git(repo, "show", `${jobBranchName("j1")}:shared.txt`)).toBe(
      "line 1\nfrom t1 and t2\nline 3\n",
    );
  });

  it("fails the check on a test timeout and blocks the merge (Req 9.4)", async () => {
    const { repo } = await scriptedRepo();
    const m = manager(repo, { testCommand: HANG, checkTimeoutMs: 300 });
    const wt = await newTask(m, "t1");
    await edit(wt, "feature.txt", "x\n");
    const before = tip(repo, jobBranchName("j1"));

    const res = await m.verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });

    expect(res.verification.tests).toMatchObject({ passed: false, timedOut: true });
    expect(res.verification.tests.cause).toContain("limit");
    expect(res.verification.decision).not.toBe("merge");
    expect(res.verification.failureOutput).toContain("tests");
    expect(res.merge).toBeUndefined();
    expect(await m.mergeTask({ jobId: "j1", taskId: "t1" })).toMatchObject({
      status: "not_verified",
    });
    expect(tip(repo, jobBranchName("j1"))).toBe(before);
  });

  it("fails the Task and leaves the Job_Branch unchanged when the worktree cannot be created (Req 9.2)", async () => {
    const { repo, baseSha } = await scriptedRepo();
    const m = manager(repo);
    // A non-empty directory at the Task's path makes `git worktree add` refuse.
    const blocked = path.join(repo, ".friday", "worktrees", "j1", "t1");
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, "in-the-way.txt"), "x");

    const res = await m.createTaskWorktree({ jobId: "j1", taskId: "t1" });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("t1");
    expect(res.jobBranchUnchanged).toBe(true);
    expect(tip(repo, jobBranchName("j1"))).toBe(baseSha);
    expect(tip(repo, "main")).toBe(baseSha);
    expect(m.writeScope("j1", "t1")).toBeUndefined();
  });

  it("keeps a worktree it cannot remove, reports its path, and keeps every branch (Req 9.10, 9.11)", async () => {
    const { repo } = await scriptedRepo();
    const m = manager(repo);
    const w1 = await newTask(m, "t1");
    const w2 = await newTask(m, "t2");
    // Untracked work makes `git worktree remove` (never forced) refuse for t1.
    await edit(w1, "unsaved.txt", "work in progress\n");
    const before = branches(repo).toSorted();

    const result = await m.cleanupJob("j1");

    expect(result.removed).toEqual([w2]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]?.path).toBe(w1);
    expect(result.message).toContain(w1);
    await expect(fs.stat(w1)).resolves.toBeDefined();
    await expect(fs.stat(w2)).rejects.toThrow();
    expect(branches(repo).toSorted()).toEqual(before);
    expect(branches(repo)).toEqual(
      expect.arrayContaining([
        jobBranchName("j1"),
        taskBranchName("j1", "t1"),
        taskBranchName("j1", "t2"),
      ]),
    );
  });
});
