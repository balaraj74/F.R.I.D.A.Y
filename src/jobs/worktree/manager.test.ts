import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorktreeManager, type WorktreeManager } from "./manager.js";
import type { WorktreeManagerDeps } from "./manager-types.js";
import { encodeRefSegment } from "./names.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./runner.js";

const REPO = "/repo";
const ROOT = "/repo/.friday/worktrees";
const T1_PATH = `${ROOT}/j1/t1`;
const INTEGRATION = `${ROOT}/j1/%integration`;
const JOB_BRANCH = "friday/job/j1";
const T1_BRANCH = "friday/task/j1/t1";
const SHA = "a".repeat(40);

type Handler = (call: CommandRequest, cmd: string) => Partial<CommandResult> | undefined;

/** Scripted runner: `handler` answers the calls it knows about, everything else succeeds quietly. */
function fakeRunner(handler: Handler = () => undefined) {
  const calls: CommandRequest[] = [];
  const run: CommandRunner = async (call) => {
    calls.push(call);
    const reply = handler(call, `${call.file} ${call.args.join(" ")}`);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...reply };
  };
  return { run, calls, cmds: () => calls.map((c) => `${c.file} ${c.args.join(" ")}`) };
}

function manager(run: CommandRunner, extra: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return createWorktreeManager({
    repoRoot: REPO,
    run,
    realpath: async (p) => p,
    ...extra,
  });
}

/** Answers the git calls of a healthy repo where the Job_Branch exists and the Task is checked out. */
const healthy =
  (extra: Handler = () => undefined): Handler =>
  (call, cmd) => {
    const mine = extra(call, cmd);
    if (mine) return mine;
    if (cmd === `git rev-parse --verify --quiet refs/heads/${T1_BRANCH}`) return { exitCode: 1 };
    if (cmd === "git rev-parse -q --verify MERGE_HEAD") return { exitCode: 1 };
    if (cmd === "git status --porcelain") return { stdout: "" };
    if (cmd === "git worktree list --porcelain") return { stdout: `worktree ${REPO}\n` };
    if (cmd.startsWith("git rev-parse")) return { stdout: `${SHA}\n` };
    return undefined;
  };

afterEach(() => {
  vi.useRealTimers();
});

describe("createTaskWorktree", () => {
  it("creates the Job_Branch, then a worktree and branch for the Task", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === `git rev-parse --verify --quiet refs/heads/${JOB_BRANCH}`
          ? { exitCode: 1 }
          : undefined,
      ),
    );
    const res = await manager(run).createTaskWorktree({ jobId: "j1", taskId: "t1" });
    expect(res).toEqual({ ok: true, path: T1_PATH, branch: T1_BRANCH, reused: false });
    expect(cmds()).toContain(`git branch ${JOB_BRANCH} HEAD`);
    expect(cmds()).toContain(`git worktree add -b ${T1_BRANCH} ${T1_PATH} ${JOB_BRANCH}`);
  });

  it("fails the Task without touching the Job_Branch when git cannot add the worktree", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) =>
        cmd.startsWith("git worktree add")
          ? { exitCode: 128, stderr: "fatal: disk full" }
          : undefined,
      ),
    );
    const res = await manager(run).createTaskWorktree({ jobId: "j1", taskId: "t1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("disk full");
      expect(res.jobBranchUnchanged).toBe(true);
    }
    expect(cmds().some((c) => c.startsWith("git merge") || c.startsWith("git commit"))).toBe(false);
  });

  it("fails when creation does not finish within 30 seconds", async () => {
    vi.useFakeTimers();
    const hang: CommandRunner = () => new Promise<CommandResult>(() => {});
    const pending = manager(hang).createTaskWorktree({ jobId: "j1", taskId: "t1" });
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("timed out");
  });

  it("caps a longer creation budget at 30 seconds", async () => {
    const { run, calls } = fakeRunner(healthy());
    await manager(run, { createTimeoutMs: 120_000 }).createTaskWorktree({
      jobId: "j1",
      taskId: "t1",
    });
    expect(Math.max(...calls.map((c) => c.timeoutMs))).toBeLessThanOrEqual(30_000);
  });

  it("reuses a worktree that already exists", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === "git worktree list --porcelain"
          ? { stdout: `worktree ${REPO}\n\nworktree ${T1_PATH}\n` }
          : undefined,
      ),
    );
    const res = await manager(run).createTaskWorktree({ jobId: "j1", taskId: "t1" });
    expect(res).toMatchObject({ ok: true, reused: true });
    expect(cmds().some((c) => c.startsWith("git worktree add"))).toBe(false);
  });

  it("rejects an unsafe start branch before running git", async () => {
    const { run, calls } = fakeRunner();
    const res = await manager(run).createTaskWorktree({
      jobId: "j1",
      taskId: "t1",
      startBranch: "--evil",
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("verifyTask", () => {
  const checks =
    (tests: Partial<CommandResult>, lint: Partial<CommandResult>): Handler =>
    (c) =>
      c.file === "pnpm" ? (c.args[0] === "test" ? tests : lint) : undefined;

  it("snapshots pending work, runs tests and lint in the Task's worktree, and decides merge", async () => {
    const { run, calls, cmds } = fakeRunner(
      healthy((c, cmd) => {
        if (cmd === "git status --porcelain") return { stdout: " M src/a.ts\n" };
        return checks({}, {})(c, cmd);
      }),
    );
    const res = await manager(run).verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.decision).toBe("merge");
    expect(cmds()).toContain("git add -A");
    const test = calls.find((c) => c.file === "pnpm" && c.args[0] === "test");
    expect(test?.cwd).toBe(T1_PATH);
    expect(test?.timeoutMs).toBe(600_000);
    expect(calls.find((c) => c.file === "pnpm" && c.args[0] === "lint")?.cwd).toBe(T1_PATH);
  });

  it("returns retry with the failure output, then failed on the third attempt", async () => {
    const { run } = fakeRunner(healthy(checks({ exitCode: 1, stdout: "1 test failed" }, {})));
    const m = manager(run);
    const first = await m.verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(first.decision).toBe("retry");
    expect(first.tests.passed).toBe(false);
    expect(first.lint.passed).toBe(true);
    expect(first.failureOutput).toContain("1 test failed");
    expect((await m.verifyTask({ jobId: "j1", taskId: "t1", attempt: 3 })).decision).toBe("failed");
  });

  it("records a timed-out check as failed with the cause", async () => {
    const { run } = fakeRunner(healthy(checks({}, { exitCode: null, timedOut: true })));
    const res = await manager(run).verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.lint).toMatchObject({ passed: false, timedOut: true });
    expect(res.lint.cause).toContain("600s");
    expect(res.decision).toBe("retry");
  });

  it("records a check that cannot be executed as failed", async () => {
    const { run } = fakeRunner(healthy(checks({ exitCode: null, error: "spawn pnpm ENOENT" }, {})));
    const res = await manager(run).verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.tests.cause).toContain("could not be executed");
    expect(res.decision).toBe("retry");
  });

  it("does not run the checks or commit while merge conflicts are unresolved", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === "git ls-files -u" ? { stdout: "100644 abc 1\tsrc/a.ts\n" } : undefined,
      ),
    );
    const res = await manager(run).verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.decision).toBe("retry");
    expect(res.tests.cause).toContain("unresolved merge conflicts in src/a.ts");
    expect(cmds().some((c) => c.startsWith("pnpm") || c === "git add -A")).toBe(false);
  });
});

describe("mergeTask and verifyAndMerge", () => {
  const mergeScript = (mergeReply: Partial<CommandResult>, unmerged = ""): Handler =>
    healthy((c, cmd) => {
      if (cmd === `git rev-parse --verify --quiet refs/heads/${JOB_BRANCH}`) return {};
      if (cmd === `git merge --no-ff --no-edit ${T1_BRANCH}`) return mergeReply;
      if (cmd === "git ls-files -u" && c.cwd === INTEGRATION) return { stdout: unmerged };
      return undefined;
    });

  it("refuses to merge a Task that has not passed verification", async () => {
    const { run, cmds } = fakeRunner(mergeScript({}));
    const res = await manager(run).mergeTask({ jobId: "j1", taskId: "t1" });
    expect(res.status).toBe("not_verified");
    expect(cmds().some((c) => c.startsWith("git merge"))).toBe(false);
  });

  it("merges into the Job_Branch checkout when tests and lint pass", async () => {
    const { run, calls } = fakeRunner(mergeScript({}));
    const res = await manager(run).verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.verification.decision).toBe("merge");
    expect(res.merge).toEqual({ status: "merged", taskId: "t1", commit: SHA });
    const merge = calls.find((c) => c.args[0] === "merge");
    expect(merge?.cwd).toBe(INTEGRATION);
    expect(
      calls.some((c) => c.args.join(" ") === `worktree add ${INTEGRATION} ${JOB_BRANCH}`),
    ).toBe(true);
  });

  it("blocks the merge and leaves the Job_Branch alone when a check fails", async () => {
    const { run, cmds } = fakeRunner(
      healthy((c) => (c.file === "pnpm" && c.args[0] === "test" ? { exitCode: 1 } : undefined)),
    );
    const res = await manager(run).verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.verification.decision).toBe("retry");
    expect(res.merge).toBeUndefined();
    expect(cmds().some((c) => c.startsWith("git merge"))).toBe(false);
  });

  it("aborts a conflicting merge and returns a reconcile request", async () => {
    const { run, cmds } = fakeRunner(
      mergeScript(
        { exitCode: 1, stdout: "CONFLICT" },
        "100644 a 1\tsrc/x.ts\n100644 b 2\tsrc/x.ts\n",
      ),
    );
    const res = await manager(run).verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });
    expect(res.merge).toMatchObject({
      status: "conflict",
      files: ["src/x.ts"],
      jobBranchUnchanged: true,
      reconcile: { conflictingBranch: T1_BRANCH, jobBranch: JOB_BRANCH, files: ["src/x.ts"] },
    });
    expect(cmds()).toContain("git merge --abort");
    // The conflicting Task must be verified again (after reconciling) before it can merge.
    const again = await manager(run).mergeTask({ jobId: "j1", taskId: "t1" });
    expect(again.status).toBe("not_verified");
  });

  it("refuses to merge when the Task branch moved after verification", async () => {
    let tip = SHA;
    const { run } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === `git rev-parse --verify refs/heads/${T1_BRANCH}`
          ? { stdout: `${tip}\n` }
          : undefined,
      ),
    );
    const m = manager(run);
    expect((await m.verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 })).decision).toBe("merge");
    tip = "b".repeat(40);
    expect((await m.mergeTask({ jobId: "j1", taskId: "t1" })).status).toBe("not_verified");
  });

  it("merges done Tasks in dependency order and stops at the first that does not merge", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) => {
        if (cmd === "git merge --no-ff --no-edit friday/task/j1/b") return { exitCode: 1 };
        return undefined;
      }),
    );
    const m = manager(run);
    for (const t of ["a", "b", "c"]) await m.verifyTask({ jobId: "j1", taskId: t, attempt: 1 });
    const res = await m.mergeInOrder({
      jobId: "j1",
      doneTasks: [
        { id: "c", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
        { id: "a", dependsOn: [] },
      ],
    });
    expect(res.order).toEqual(["a", "b", "c"]);
    expect(res.results.map((r) => r.status)).toEqual(["merged", "failed"]);
    expect(res.skipped).toEqual(["c"]);
    expect(cmds().filter((c) => c.startsWith("git merge --no-ff"))).toHaveLength(2);
  });
});

describe("beginReconcile", () => {
  it("starts the reconcile Task from the Job_Branch with the conflicting branch merged in", async () => {
    const { run, calls } = fakeRunner(
      healthy((c, cmd) => {
        if (cmd === `git merge --no-ff --no-edit ${T1_BRANCH}`) return { exitCode: 1 };
        if (cmd === "git ls-files -u") return { stdout: "100644 a 1\tsrc/x.ts\n" };
        return undefined;
      }),
    );
    const res = await manager(run).beginReconcile({
      jobId: "j1",
      reconcileTaskId: "r1",
      conflictingTaskId: "t1",
    });
    expect(res).toMatchObject({ ok: true, path: `${ROOT}/j1/r1`, conflictFiles: ["src/x.ts"] });
    expect(calls.find((c) => c.args[0] === "merge")?.cwd).toBe(`${ROOT}/j1/r1`);
  });
});

describe("approval-gated actions", () => {
  it("only describes the Job_Branch into user branch merge", () => {
    const { run, calls } = fakeRunner();
    const pending = manager(run).requestJobMerge({ jobId: "j1", userBranch: "main" });
    expect(pending).toMatchObject({ state: "waiting_approval", kind: "code:merge" });
    expect(pending.description).toContain("main");
    expect(calls).toHaveLength(0);
  });

  it("does not merge into the user's branch without a granted Approval", async () => {
    const { run, calls } = fakeRunner(healthy());
    const m = manager(run);
    expect(
      await m.applyJobMerge({ jobId: "j1", userBranch: "main", approval: { granted: false } }),
    ).toEqual({
      status: "not_approved",
    });
    expect(
      await m.applyJobMerge({ jobId: "j1", userBranch: "main", approval: undefined as never }),
    ).toEqual({ status: "not_approved" });
    expect(calls).toHaveLength(0);
  });

  it("merges in place when the user's branch is already checked out", async () => {
    const { run, calls } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === "git rev-parse --abbrev-ref HEAD" ? { stdout: "main\n" } : undefined,
      ),
    );
    const res = await manager(run).applyJobMerge({
      jobId: "j1",
      userBranch: "main",
      approval: { granted: true },
    });
    expect(res).toEqual({ status: "merged", commit: SHA });
    expect(calls.find((c) => c.args[0] === "merge")).toMatchObject({ cwd: REPO });
    expect(calls.some((c) => c.args[0] === "worktree")).toBe(false);
  });

  it("merges in a temporary worktree when another branch is checked out, then removes it", async () => {
    const final = `${ROOT}/j1/%final`;
    const { run, cmds, calls } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === "git rev-parse --abbrev-ref HEAD" ? { stdout: "feature\n" } : undefined,
      ),
    );
    await manager(run).applyJobMerge({
      jobId: "j1",
      userBranch: "main",
      approval: { granted: true },
    });
    expect(cmds()).toContain(`git worktree add ${final} main`);
    expect(calls.find((c) => c.args[0] === "merge")?.cwd).toBe(final);
    expect(cmds()).toContain(`git worktree remove ${final}`);
  });

  it("reports a conflict when merging into the user's branch and aborts it", async () => {
    const { run, cmds } = fakeRunner(
      healthy((_c, cmd) => {
        if (cmd === "git rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
        if (cmd === `git merge --no-ff --no-edit ${JOB_BRANCH}`) return { exitCode: 1 };
        if (cmd === "git ls-files -u") return { stdout: "100644 a 1\tf.ts\n" };
        return undefined;
      }),
    );
    const res = await manager(run).applyJobMerge({
      jobId: "j1",
      userBranch: "main",
      approval: { granted: true },
    });
    expect(res).toEqual({ status: "conflict", files: ["f.ts"] });
    expect(cmds()).toContain("git merge --abort");
  });

  it("routes git push to approval and has no way to run it", () => {
    const { run, calls } = fakeRunner();
    const pending = manager(run).requestPush({ remote: "origin", branch: "main" });
    expect(pending).toMatchObject({ state: "waiting_approval", kind: "git push" });
    expect(calls).toHaveLength(0);
  });

  it("never runs git push across a full job flow", async () => {
    const { run, calls } = fakeRunner(
      healthy((_c, cmd) =>
        cmd === "git rev-parse --abbrev-ref HEAD" ? { stdout: "main\n" } : undefined,
      ),
    );
    const m = manager(run);
    await m.createTaskWorktree({ jobId: "j1", taskId: "t1" });
    await m.verifyAndMerge({ jobId: "j1", taskId: "t1", attempt: 1 });
    await m.applyJobMerge({ jobId: "j1", userBranch: "main", approval: { granted: true } });
    await m.cleanupJob("j1");
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });
});

describe("cleanupJob", () => {
  const listing = [
    `worktree ${REPO}`,
    `worktree ${T1_PATH}`,
    `worktree ${INTEGRATION}`,
    `worktree ${ROOT}/j2/t9`,
    "worktree /home/user/other",
    "",
  ].join("\n");

  it("removes only this Job's worktrees, keeps unremovable ones, and reports their paths", async () => {
    const { run, cmds } = fakeRunner((_c, cmd) => {
      if (cmd === "git worktree list --porcelain") return { stdout: listing };
      if (cmd === `git worktree remove ${T1_PATH}`)
        return { exitCode: 128, stderr: "contains modified files" };
      return undefined;
    });
    const res = await manager(run).cleanupJob("j1");
    expect(res.removed).toEqual([INTEGRATION]);
    expect(res.kept).toEqual([{ path: T1_PATH, reason: "contains modified files" }]);
    expect(res.message).toContain(T1_PATH);
    const removals = cmds().filter((c) => c.startsWith("git worktree remove"));
    expect(removals).toEqual([
      `git worktree remove ${T1_PATH}`,
      `git worktree remove ${INTEGRATION}`,
    ]);
    // Branches stay, and nothing is forced.
    expect(
      cmds().some((c) => c.startsWith("git branch") || /(^| )(-f|--force|-D)( |$)/.test(c)),
    ).toBe(false);
  });

  it("returns no message when everything was removed", async () => {
    const { run } = fakeRunner((_c, cmd) =>
      cmd === "git worktree list --porcelain" ? { stdout: listing } : undefined,
    );
    const res = await manager(run).cleanupJob("j1");
    expect(res.removed).toHaveLength(2);
    expect(res).toMatchObject({ kept: [], message: null });
  });

  it("reports the Job directory when worktrees cannot be listed", async () => {
    const { run } = fakeRunner((_c, cmd) =>
      cmd === "git worktree list --porcelain"
        ? { exitCode: 128, stderr: "not a repository" }
        : undefined,
    );
    const res = await manager(run).cleanupJob("j1");
    expect(res.removed).toEqual([]);
    expect(res.kept[0]?.path).toBe(`${ROOT}/j1`);
  });
});

describe("git command guard", () => {
  it("rejects push, branch deletion and forced removal even from a configured command", async () => {
    const { run, calls } = fakeRunner(healthy());
    const m = manager(run, { testCommand: { file: "git", args: ["push", "origin", "main"] } });
    await expect(m.verifyTask({ jobId: "j1", taskId: "t1", attempt: 1 })).rejects.toThrow(
      /not allowed/,
    );
    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
  });
});

describe("preAction confinement hook", () => {
  async function withTask(declaredPaths?: string[]) {
    const { run } = fakeRunner(healthy());
    const m = manager(run);
    await m.createTaskWorktree({
      jobId: "j1",
      taskId: "t1",
      ...(declaredPaths ? { declaredPaths } : {}),
    });
    const check = (tool: string, args: unknown, taskId = "t1") =>
      m.preAction({ jobId: "j1", taskId, role: "builder", tool, args });
    return check;
  }

  it("allows writes inside the worktree and denies writes outside it", async () => {
    const check = await withTask();
    expect(await check("write", { path: "src/a.ts" })).toEqual({ allow: true });
    expect(await check("edit", { file_path: `${T1_PATH}/x.ts` })).toEqual({ allow: true });
    expect(await check("write", { path: "../../../../etc/passwd" })).toMatchObject({
      allow: false,
    });
    expect(await check("write", { path: "/home/user/Documents/a.txt" })).toMatchObject({
      allow: false,
    });
  });

  it("allows declared repository paths and checks every file in a patch", async () => {
    const check = await withTask(["docs"]);
    expect(await check("write", { path: "/repo/docs/a.md" })).toEqual({ allow: true });
    const patch = "*** Update File: src/a.ts\n*** Update File: /repo/src/outside.ts\n";
    expect(await check("apply_patch", { input: patch })).toMatchObject({ allow: false });
  });

  it("refuses a write whose target cannot be determined", async () => {
    const check = await withTask();
    expect(await check("write", {})).toMatchObject({ allow: false });
  });

  it("passes through other tools and Tasks without a worktree", async () => {
    const check = await withTask();
    expect(await check("read", { path: "/etc/hostname" })).toEqual({ allow: true });
    expect(await check("write", { path: "/anywhere" }, "no-worktree")).toEqual({ allow: true });
  });
});

describe("encodeRefSegment", () => {
  it("always yields a git-safe segment and never collides", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        const ea = encodeRefSegment("id", a);
        expect(ea).toMatch(/^[A-Za-z0-9_%-]+$/);
        if (a !== b) expect(ea).not.toBe(encodeRefSegment("id", b));
      }),
      { numRuns: 200 },
    );
  });
});
