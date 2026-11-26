import fs from "node:fs/promises";
import path from "node:path";

import { classifyAction } from "../orchestrator/approvals.js";
import type { PreActionHook } from "../orchestrator/runtime-types.js";
import { createConfinementHook } from "./confinement-hook.js";
import {
  DEFAULT_WORKTREE_ROOT,
  planMergeOrder,
  verifyOutcome,
  worktreePath,
  type MergeableTask,
  type WriteScope,
} from "./logic.js";
import type {
  ApplyJobMergeResult,
  CheckResult,
  CleanupResult,
  CommandSpec,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  JobMergeApproval,
  MergeInOrderResult,
  MergeTaskResult,
  PendingApproval,
  ReconcileWorktreeResult,
  VerifyAndMergeResult,
  VerifyResult,
  WorktreeManagerDeps,
} from "./manager-types.js";
import {
  assertSafeBranchName,
  finalMergeWorktreePath,
  integrationWorktreePath,
  jobBranchName,
  jobWorktreeDir,
  taskBranchName,
} from "./names.js";
import { assertGitCommandAllowed, execFileRunner, type CommandResult } from "./runner.js";

/** Requirement 9.1/9.2: a Worktree and branch must exist within this long. */
export const WORKTREE_CREATE_TIMEOUT_MS = 30_000;
/** Requirement 9.3/9.4: upper limit for one test or lint run. */
export const CHECK_TIMEOUT_MS = 600_000;
const GIT_TIMEOUT_MS = 60_000;
/** Extra time a check gets to hand back its output after the runner's own kill fires. */
const CHECK_GRACE_MS = 2_000;
const OUTPUT_TAIL_CHARS = 8_000;

type GitStep = (args: readonly string[]) => Promise<CommandResult>;

const keyOf = (jobId: string, taskId: string) => JSON.stringify([jobId, taskId]);

function describeFailure(res: CommandResult): string {
  if (res.timedOut) {
    return "timed out";
  }
  if (res.error) {
    return res.error;
  }
  const text = `${res.stderr}\n${res.stdout}`.trim();
  return text.length > 0 ? text.slice(0, 500) : `exited with code ${res.exitCode}`;
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > OUTPUT_TAIL_CHARS ? `...${t.slice(-OUTPUT_TAIL_CHARS)}` : t;
}

function isStrictlyWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Paths git prints for each unmerged file (`<mode> <sha> <stage>\t<path>`). */
function unmergedFiles(lsFilesOutput: string): string[] {
  const files = new Set<string>();
  for (const line of lsFilesOutput.split("\n")) {
    const file = line.split("\t")[1];
    if (file) {
      files.add(file);
    }
  }
  return [...files];
}

export interface WorktreeManager {
  /** Req 9.1/9.2: Worktree + branch for a coding Task within 30s, or a failure that leaves the Job_Branch alone. */
  createTaskWorktree(req: CreateWorktreeRequest): Promise<CreateWorktreeResult>;
  /** Req 9.3/9.4/9.6: run tests and lint in the Task's Worktree and decide merge, retry or failed. */
  verifyTask(req: { jobId: string; taskId: string; attempt: number }): Promise<VerifyResult>;
  /** Req 9.5/9.7: merge a verified Task branch into the Job_Branch. Conflicts are aborted. */
  mergeTask(req: { jobId: string; taskId: string }): Promise<MergeTaskResult>;
  /** `verifyTask`, then `mergeTask` only when the decision is merge. */
  verifyAndMerge(req: {
    jobId: string;
    taskId: string;
    attempt: number;
  }): Promise<VerifyAndMergeResult>;
  /** Merge verified Tasks in dependency order (`planMergeOrder`), stopping at the first that does not merge. */
  mergeInOrder(req: {
    jobId: string;
    doneTasks: readonly MergeableTask[];
  }): Promise<MergeInOrderResult>;
  /** Req 9.7: Worktree for a reconcile Task, started from the Job_Branch with the conflicting branch merged in. */
  beginReconcile(req: {
    jobId: string;
    reconcileTaskId: string;
    conflictingTaskId: string;
    declaredPaths?: readonly string[];
  }): Promise<ReconcileWorktreeResult>;
  /** Req 9.8: describes the Job_Branch into user branch merge. Performs nothing. */
  requestJobMerge(req: { jobId: string; userBranch: string }): PendingApproval;
  /** Req 9.8: performs the merge into the user's branch, and only with a granted Approval. */
  applyJobMerge(req: {
    jobId: string;
    userBranch: string;
    approval: JobMergeApproval;
  }): Promise<ApplyJobMergeResult>;
  /** Req 9.9: describes a push for the approval path. This module has no way to push. */
  requestPush(req: { remote?: string; branch?: string }): PendingApproval;
  /** Req 9.10/9.11: remove the Job's Worktrees, keep every branch, report what could not be removed. */
  cleanupJob(jobId: string): Promise<CleanupResult>;
  /** Where a Task may write; undefined for Tasks without a Worktree. */
  writeScope(jobId: string, taskId: string): WriteScope | undefined;
  /** Req 9.12: pre-action hook that confines file writes. Pass it as the Orchestrator's `preAction`. */
  preAction: PreActionHook;
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const run = deps.run ?? execFileRunner;
  const now = deps.now ?? (() => Date.now());
  const rootSetting = deps.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  const createBudgetMs = Math.max(
    1,
    Math.min(deps.createTimeoutMs ?? WORKTREE_CREATE_TIMEOUT_MS, WORKTREE_CREATE_TIMEOUT_MS),
  );
  const checkLimitMs = Math.max(
    1,
    Math.min(deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS),
  );
  const gitTimeoutMs = deps.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const baseRef = deps.baseRef ?? "HEAD";
  const testCommand: CommandSpec = deps.testCommand ?? { file: "pnpm", args: ["test"] };
  const lintCommand: CommandSpec = deps.lintCommand ?? { file: "pnpm", args: ["lint"] };
  const realpath = deps.realpath ?? ((p: string) => fs.realpath(p));

  /** Scope per Task, for confinement and for finding the Job's Worktrees. */
  const scopes = new Map<string, WriteScope & { jobId: string }>();
  /** Task id -> branch tip that passed verification. A merge needs the tip to be unchanged. */
  const verified = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();

  let repoPromise: Promise<string> | undefined;
  const repoRoot = (): Promise<string> => {
    repoPromise ??= realpath(deps.repoRoot).catch(() => path.resolve(deps.repoRoot));
    return repoPromise;
  };

  /** One merge at a time per Job, so parallel Tasks never race on the Job_Branch checkout. */
  function serial<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(jobId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      jobId,
      next.catch(() => undefined),
    );
    return next;
  }

  async function exec(
    file: string,
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    graceMs = 0,
  ): Promise<CommandResult> {
    assertGitCommandAllowed(file, args);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<CommandResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
        timeoutMs + graceMs,
      );
    });
    const call = Promise.resolve()
      .then(() => run({ file, args, cwd, timeoutMs }))
      .catch(
        (err: unknown): CommandResult => ({
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    try {
      return await Promise.race([call, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  const gitIn =
    (cwd: string): GitStep =>
    (args) =>
      exec("git", args, cwd, gitTimeoutMs);

  async function listWorktrees(
    step: GitStep,
  ): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
    const res = await step(["worktree", "list", "--porcelain"]);
    if (res.exitCode !== 0) {
      return { ok: false, reason: describeFailure(res) };
    }
    const paths = res.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => path.resolve(l.slice("worktree ".length)));
    return { ok: true, paths };
  }

  /** Creates the Job_Branch from `baseRef` when it is missing. Returns an error text or null. */
  async function ensureJobBranch(step: GitStep, jobBranch: string): Promise<string | null> {
    const exists = await step(["rev-parse", "--verify", "--quiet", `refs/heads/${jobBranch}`]);
    if (exists.exitCode === 0) {
      return null;
    }
    if (exists.exitCode !== 1) {
      return describeFailure(exists);
    }
    const created = await step(["branch", jobBranch, baseRef]);
    return created.exitCode === 0
      ? null
      : `cannot create ${jobBranch}: ${describeFailure(created)}`;
  }

  function register(
    jobId: string,
    taskId: string,
    repo: string,
    worktree: string,
    declaredPaths: readonly string[] | undefined,
  ): void {
    scopes.set(keyOf(jobId, taskId), {
      jobId,
      repoRoot: repo,
      worktree,
      ...(declaredPaths ? { declaredPaths: [...declaredPaths] } : {}),
    });
  }

  // -------------------------------------------------------------------------------------
  // Creation (Req 9.1, 9.2)
  // -------------------------------------------------------------------------------------

  async function createTaskWorktree(req: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
    const fail = (reason: string): CreateWorktreeResult => ({
      ok: false,
      reason: `Cannot create a worktree for task ${req.taskId} of job ${req.jobId}: ${reason}`,
      jobBranchUnchanged: true,
    });
    let jobBranch: string;
    let taskBranch: string;
    try {
      jobBranch = jobBranchName(req.jobId);
      taskBranch = taskBranchName(req.jobId, req.taskId);
      if (req.startBranch !== undefined) {
        assertSafeBranchName(req.startBranch);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const repo = await repoRoot();
    const wt = path.resolve(repo, worktreePath(req.jobId, req.taskId, rootSetting));

    // One budget for the whole creation: each git call gets what is left of the 30 seconds.
    const startedAt = now();
    const step: GitStep = (args) => {
      const left = createBudgetMs - (now() - startedAt);
      return left <= 0
        ? Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true })
        : exec("git", args, repo, left);
    };

    const branchError = await ensureJobBranch(step, jobBranch);
    if (branchError !== null) {
      return fail(branchError);
    }
    const listed = await listWorktrees(step);
    if (!listed.ok) {
      return fail(`cannot list worktrees: ${listed.reason}`);
    }
    if (listed.paths.includes(wt)) {
      register(req.jobId, req.taskId, repo, wt, req.declaredPaths);
      return { ok: true, path: wt, branch: taskBranch, reused: true };
    }
    const branchExists = await step([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${taskBranch}`,
    ]);
    if (branchExists.exitCode !== 0 && branchExists.exitCode !== 1) {
      return fail(describeFailure(branchExists));
    }
    const add =
      branchExists.exitCode === 0
        ? await step(["worktree", "add", wt, taskBranch])
        : await step(["worktree", "add", "-b", taskBranch, wt, req.startBranch ?? jobBranch]);
    if (add.exitCode !== 0) {
      return fail(describeFailure(add));
    }
    register(req.jobId, req.taskId, repo, wt, req.declaredPaths);
    return { ok: true, path: wt, branch: taskBranch, reused: false };
  }

  // -------------------------------------------------------------------------------------
  // Verification (Req 9.3, 9.4, 9.6)
  // -------------------------------------------------------------------------------------

  async function runCheck(
    name: CheckResult["name"],
    spec: CommandSpec,
    cwd: string,
  ): Promise<CheckResult> {
    const startedAt = now();
    const res = await exec(spec.file, spec.args, cwd, checkLimitMs, CHECK_GRACE_MS);
    const passed = res.exitCode === 0 && !res.timedOut && res.error === undefined;
    let cause: string | undefined;
    if (!passed) {
      if (res.timedOut) {
        cause = `${name} exceeded the ${Math.round(checkLimitMs / 1000)}s limit`;
      } else if (res.error !== undefined) {
        cause = `${name} could not be executed: ${res.error}`;
      } else {
        cause = `${name} exited with code ${res.exitCode}`;
      }
    }
    return {
      name,
      passed,
      timedOut: res.timedOut,
      exitCode: res.exitCode,
      ...(cause !== undefined ? { cause } : {}),
      output: tail(`${res.stdout}\n${res.stderr}`),
      durationMs: Math.max(0, now() - startedAt),
    };
  }

  const notRun = (name: CheckResult["name"], cause: string): CheckResult => ({
    name,
    passed: false,
    timedOut: false,
    exitCode: null,
    cause,
    output: "",
    durationMs: 0,
  });

  /**
   * Commits pending work so the tested tree is exactly what the branch will merge. Returns the
   * branch tip, or an error text. Unresolved conflicts are never committed.
   */
  async function snapshot(
    git: GitStep,
    taskId: string,
  ): Promise<{ sha: string } | { error: string }> {
    const unmerged = await git(["ls-files", "-u"]);
    if (unmerged.exitCode !== 0) {
      return { error: `cannot inspect worktree: ${describeFailure(unmerged)}` };
    }
    if (unmerged.stdout.trim().length > 0) {
      return {
        error: `unresolved merge conflicts in ${unmergedFiles(unmerged.stdout).join(", ")}`,
      };
    }
    const status = await git(["status", "--porcelain"]);
    if (status.exitCode !== 0) {
      return { error: `cannot inspect worktree: ${describeFailure(status)}` };
    }
    const merging = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (status.stdout.trim().length > 0 || merging.exitCode === 0) {
      const added = await git(["add", "-A"]);
      if (added.exitCode !== 0) {
        return { error: `cannot stage changes: ${describeFailure(added)}` };
      }
      const committed = await git(["commit", "-m", `friday: snapshot of task ${taskId}`]);
      if (committed.exitCode !== 0) {
        return { error: `cannot commit changes: ${describeFailure(committed)}` };
      }
    }
    const head = await git(["rev-parse", "HEAD"]);
    if (head.exitCode !== 0 || head.stdout.trim() === "") {
      return { error: `cannot read branch tip: ${describeFailure(head)}` };
    }
    return { sha: head.stdout.trim() };
  }

  async function verifyTask(req: {
    jobId: string;
    taskId: string;
    attempt: number;
  }): Promise<VerifyResult> {
    const key = keyOf(req.jobId, req.taskId);
    verified.delete(key);
    const repo = await repoRoot();
    const wt = path.resolve(repo, worktreePath(req.jobId, req.taskId, rootSetting));

    let tests: CheckResult;
    let lint: CheckResult;
    let sha: string | undefined;
    const prepared = await snapshot(gitIn(wt), req.taskId);
    if ("error" in prepared) {
      tests = notRun("tests", `not run: ${prepared.error}`);
      lint = notRun("lint", `not run: ${prepared.error}`);
    } else {
      sha = prepared.sha;
      tests = await runCheck("tests", testCommand, wt);
      lint = await runCheck("lint", lintCommand, wt);
    }
    const decision = verifyOutcome(tests.passed, lint.passed, req.attempt);
    if (decision === "merge" && sha !== undefined) {
      verified.set(key, sha);
    }
    const failed = [tests, lint].filter((c) => !c.passed);
    const failureOutput = failed
      .map((c) => `[${c.name}] ${c.cause ?? "failed"}\n${c.output}`.trim())
      .join("\n\n");
    return {
      decision,
      attempt: req.attempt,
      tests,
      lint,
      ...(failed.length > 0 ? { failureOutput } : {}),
    };
  }

  // -------------------------------------------------------------------------------------
  // Merge into the Job_Branch (Req 9.5, 9.7)
  // -------------------------------------------------------------------------------------

  async function ensureIntegration(
    repo: string,
    jobId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const git = gitIn(repo);
    const jobBranch = jobBranchName(jobId);
    const wt = path.resolve(repo, integrationWorktreePath(jobId, rootSetting));
    const branchError = await ensureJobBranch(git, jobBranch);
    if (branchError !== null) {
      return { ok: false, reason: branchError };
    }
    const listed = await listWorktrees(git);
    if (!listed.ok) {
      return { ok: false, reason: `cannot list worktrees: ${listed.reason}` };
    }
    if (!listed.paths.includes(wt)) {
      const add = await git(["worktree", "add", wt, jobBranch]);
      if (add.exitCode !== 0) {
        return { ok: false, reason: `cannot check out ${jobBranch}: ${describeFailure(add)}` };
      }
    }
    return { ok: true, path: wt };
  }

  /** Runs `git merge` of `branch` in `cwd`; on any failure aborts so the checkout is left as it was. */
  async function mergeOrAbort(
    git: GitStep,
    branch: string,
  ): Promise<
    | { status: "merged"; commit: string }
    | { status: "conflict"; files: string[] }
    | { status: "failed"; reason: string }
  > {
    const merge = await git(["merge", "--no-ff", "--no-edit", branch]);
    if (merge.exitCode === 0) {
      const head = await git(["rev-parse", "HEAD"]);
      return { status: "merged", commit: head.stdout.trim() };
    }
    const unmerged = await git(["ls-files", "-u"]);
    const files = unmerged.exitCode === 0 ? unmergedFiles(unmerged.stdout) : [];
    // Best effort: with no merge in progress there is nothing to abort and this errors harmlessly.
    await git(["merge", "--abort"]);
    return files.length > 0
      ? { status: "conflict", files }
      : { status: "failed", reason: describeFailure(merge) };
  }

  function mergeTask(req: { jobId: string; taskId: string }): Promise<MergeTaskResult> {
    return serial(req.jobId, async (): Promise<MergeTaskResult> => {
      const key = keyOf(req.jobId, req.taskId);
      const repo = await repoRoot();
      const taskBranch = taskBranchName(req.jobId, req.taskId);
      const jobBranch = jobBranchName(req.jobId);

      const expected = verified.get(key);
      if (expected === undefined) {
        return {
          status: "not_verified",
          taskId: req.taskId,
          reason: "tests and lint have not passed for this task",
        };
      }
      const tip = await gitIn(repo)(["rev-parse", "--verify", `refs/heads/${taskBranch}`]);
      if (tip.exitCode !== 0 || tip.stdout.trim() !== expected) {
        verified.delete(key);
        return {
          status: "not_verified",
          taskId: req.taskId,
          reason: "the task branch changed after it was verified",
        };
      }

      const integration = await ensureIntegration(repo, req.jobId);
      if (!integration.ok) {
        return {
          status: "failed",
          taskId: req.taskId,
          reason: integration.reason,
          jobBranchUnchanged: true,
        };
      }
      const git = gitIn(integration.path);
      const before = await git(["rev-parse", "HEAD"]);
      const outcome = await mergeOrAbort(git, taskBranch);
      if (outcome.status === "merged") {
        verified.delete(key);
        return { status: "merged", taskId: req.taskId, commit: outcome.commit };
      }
      const after = await git(["rev-parse", "HEAD"]);
      const unchanged = before.exitCode === 0 && before.stdout.trim() === after.stdout.trim();
      if (outcome.status === "failed") {
        return {
          status: "failed",
          taskId: req.taskId,
          reason: outcome.reason,
          jobBranchUnchanged: unchanged,
        };
      }
      // The branch has to be reconciled and re-verified before it can merge (Req 9.7).
      verified.delete(key);
      return {
        status: "conflict",
        taskId: req.taskId,
        files: outcome.files,
        jobBranchUnchanged: unchanged,
        reconcile: {
          jobId: req.jobId,
          conflictingTaskId: req.taskId,
          conflictingBranch: taskBranch,
          jobBranch,
          files: outcome.files,
          description:
            `Merging ${taskBranch} into ${jobBranch} conflicts in ${outcome.files.join(", ")}. ` +
            "Resolve the conflicts so the result keeps both Tasks' intent, then verify the merged result.",
        },
      };
    });
  }

  async function verifyAndMerge(req: {
    jobId: string;
    taskId: string;
    attempt: number;
  }): Promise<VerifyAndMergeResult> {
    const verification = await verifyTask(req);
    if (verification.decision !== "merge") {
      return { verification };
    }
    return { verification, merge: await mergeTask(req) };
  }

  async function mergeInOrder(req: {
    jobId: string;
    doneTasks: readonly MergeableTask[];
  }): Promise<MergeInOrderResult> {
    const order = planMergeOrder(req.doneTasks);
    const results: MergeTaskResult[] = [];
    for (const [i, taskId] of order.entries()) {
      const result = await mergeTask({ jobId: req.jobId, taskId });
      results.push(result);
      if (result.status !== "merged") {
        return { order, results, skipped: order.slice(i + 1) };
      }
    }
    return { order, results, skipped: [] };
  }

  async function beginReconcile(req: {
    jobId: string;
    reconcileTaskId: string;
    conflictingTaskId: string;
    declaredPaths?: readonly string[];
  }): Promise<ReconcileWorktreeResult> {
    const created = await createTaskWorktree({
      jobId: req.jobId,
      taskId: req.reconcileTaskId,
      ...(req.declaredPaths ? { declaredPaths: req.declaredPaths } : {}),
    });
    if (!created.ok) {
      return { ok: false, reason: created.reason };
    }
    const git = gitIn(created.path);
    const merge = await git([
      "merge",
      "--no-ff",
      "--no-edit",
      taskBranchName(req.jobId, req.conflictingTaskId),
    ]);
    const unmerged = await git(["ls-files", "-u"]);
    const conflictFiles = unmerged.exitCode === 0 ? unmergedFiles(unmerged.stdout) : [];
    if (merge.exitCode !== 0 && conflictFiles.length === 0) {
      return { ok: false, reason: `cannot start the reconcile merge: ${describeFailure(merge)}` };
    }
    // Conflicts stay in place: the reconcile Task resolves them, then goes through verification.
    return { ok: true, path: created.path, branch: created.branch, conflictFiles };
  }

  // -------------------------------------------------------------------------------------
  // Approval-gated actions (Req 9.8, 9.9)
  // -------------------------------------------------------------------------------------

  function requestJobMerge(req: { jobId: string; userBranch: string }): PendingApproval {
    const verdict = classifyAction("code:merge");
    return {
      state: "waiting_approval",
      kind: "code:merge",
      reason: verdict.reason ?? "changes Sir's own branches",
      description: `Merge ${jobBranchName(req.jobId)} into ${req.userBranch}`,
    };
  }

  function requestPush(req: { remote?: string; branch?: string }): PendingApproval {
    const verdict = classifyAction("git push");
    return {
      state: "waiting_approval",
      kind: "git push",
      reason: verdict.reason ?? "pushes code to a remote",
      description: `git push${req.remote ? ` ${req.remote}` : ""}${req.branch ? ` ${req.branch}` : ""}`,
    };
  }

  function applyJobMerge(req: {
    jobId: string;
    userBranch: string;
    approval: JobMergeApproval;
  }): Promise<ApplyJobMergeResult> {
    if (req.approval?.granted !== true) {
      return Promise.resolve({ status: "not_approved" });
    }
    return serial(req.jobId, async (): Promise<ApplyJobMergeResult> => {
      try {
        assertSafeBranchName(req.userBranch);
      } catch (err) {
        return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
      const repo = await repoRoot();
      const git = gitIn(repo);
      const jobBranch = jobBranchName(req.jobId);
      const jobExists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${jobBranch}`]);
      if (jobExists.exitCode !== 0) {
        return { status: "failed", reason: `${jobBranch} does not exist` };
      }
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (current.exitCode !== 0) {
        return { status: "failed", reason: describeFailure(current) };
      }

      // Never switch the user's checkout: merge in place only if their branch is already checked out.
      let cwd = repo;
      let temp: string | undefined;
      if (current.stdout.trim() === req.userBranch) {
        const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
        if (dirty.exitCode !== 0 || dirty.stdout.trim().length > 0) {
          return { status: "failed", reason: "the working tree has uncommitted changes" };
        }
      } else {
        temp = path.resolve(repo, finalMergeWorktreePath(req.jobId, rootSetting));
        const add = await git(["worktree", "add", temp, req.userBranch]);
        if (add.exitCode !== 0) {
          return {
            status: "failed",
            reason: `cannot check out ${req.userBranch}: ${describeFailure(add)}`,
          };
        }
        cwd = temp;
      }
      try {
        const outcome = await mergeOrAbort(gitIn(cwd), jobBranch);
        return outcome;
      } finally {
        if (temp !== undefined) {
          await git(["worktree", "remove", temp]);
        }
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // Cleanup (Req 9.10, 9.11)
  // -------------------------------------------------------------------------------------

  async function cleanupJob(jobId: string): Promise<CleanupResult> {
    const repo = await repoRoot();
    const git = gitIn(repo);
    const managedRoot = path.resolve(repo, rootSetting);
    const jobDir = path.resolve(repo, jobWorktreeDir(jobId, rootSetting));
    // Removal is limited to directories this manager owns: inside the Job's directory under the managed root.
    const owned = (p: string) =>
      isStrictlyWithin(managedRoot, jobDir) && isStrictlyWithin(jobDir, p);

    const removed: string[] = [];
    const kept: CleanupResult["kept"] = [];
    const known = [...scopes.entries()]
      .filter(([, s]) => s.jobId === jobId)
      .map(([k, s]) => ({ key: k, path: s.worktree }));

    const listed = await listWorktrees(git);
    let candidates: string[];
    if (listed.ok) {
      candidates = listed.paths.filter(owned);
      // Registered Worktrees git no longer knows about need no removal.
      for (const k of known) {
        if (!listed.paths.includes(k.path)) {
          scopes.delete(k.key);
        }
      }
    } else {
      candidates = known.map((k) => k.path).filter(owned);
      if (candidates.length === 0) {
        kept.push({ path: jobDir, reason: `cannot list worktrees: ${listed.reason}` });
      }
    }

    for (const p of new Set(candidates)) {
      // No --force: a Worktree with uncommitted work stays, and branches are never deleted.
      const res = await git(["worktree", "remove", p]);
      if (res.exitCode === 0) {
        removed.push(p);
        for (const k of known) {
          if (k.path === p) {
            scopes.delete(k.key);
          }
        }
      } else {
        kept.push({ path: p, reason: describeFailure(res) });
      }
    }
    return {
      removed,
      kept,
      message:
        kept.length === 0
          ? null
          : `Kept ${kept.length} worktree(s) for job ${jobId} (branches kept too): ${kept
              .map((k) => `${k.path} (${k.reason})`)
              .join("; ")}`,
    };
  }

  const writeScope = (jobId: string, taskId: string): WriteScope | undefined =>
    scopes.get(keyOf(jobId, taskId));

  return {
    createTaskWorktree,
    verifyTask,
    mergeTask,
    verifyAndMerge,
    mergeInOrder,
    beginReconcile,
    requestJobMerge,
    applyJobMerge,
    requestPush,
    cleanupJob,
    writeScope,
    preAction: createConfinementHook(writeScope),
  };
}
