import type { VerifyDecision } from "./logic.js";
import type { CommandRunner } from "./runner.js";

/** Public shapes of the worktree manager. The Orchestrator maps these results to Task states. */

export type CommandSpec = { file: string; args: readonly string[] };

export type WorktreeManagerDeps = {
  /** Repository the Worktrees belong to. */
  repoRoot: string;
  /** Process boundary; defaults to the `execFile` runner. */
  run?: CommandRunner;
  /** Directory for Worktrees, relative to `repoRoot` unless absolute. */
  worktreeRoot?: string;
  /** Full test suite command, run inside the Task's Worktree. Default `pnpm test`. */
  testCommand?: CommandSpec;
  /** Lint command, run inside the Task's Worktree. Default `pnpm lint`. */
  lintCommand?: CommandSpec;
  /** Budget for creating a Worktree and branch. Capped at 30s (Req 9.1). */
  createTimeoutMs?: number;
  /** Limit per test/lint check. Capped at 600s (Req 9.3). */
  checkTimeoutMs?: number;
  /** Limit for every other git call. Default 60s. */
  gitTimeoutMs?: number;
  /** Ref the Job_Branch is created from when it does not exist yet. Default `HEAD`. */
  baseRef?: string;
  now?: () => number;
  /** Resolves symlinks so paths match what `git worktree list` prints. */
  realpath?: (p: string) => Promise<string>;
};

export type CreateWorktreeRequest = {
  jobId: string;
  taskId: string;
  /** Branch to start from. Defaults to the Job_Branch. */
  startBranch?: string;
  /** Extra repository paths the Task may write to besides its Worktree (Req 9.12). */
  declaredPaths?: readonly string[];
};

export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string; reused: boolean }
  | {
      ok: false;
      /** Text to show the user. The Task moves to failed (Req 9.2). */
      reason: string;
      /** Always true: creation never touches the Job_Branch's commits. */
      jobBranchUnchanged: true;
    };

export type CheckResult = {
  name: "tests" | "lint";
  passed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  /** Why the check counts as failed. Absent when it passed. */
  cause?: string;
  /** Tail of the combined output. */
  output: string;
  durationMs: number;
};

export type VerifyResult = {
  /** From `verifyOutcome`: merge, retry (Task returns to running) or failed. */
  decision: VerifyDecision;
  attempt: number;
  tests: CheckResult;
  lint: CheckResult;
  /** Output to attach to the Task when the decision is retry or failed. */
  failureOutput?: string;
};

/** What the Orchestrator needs to create a reconcile Task after a conflict (Req 9.7). */
export type ReconcileRequest = {
  jobId: string;
  conflictingTaskId: string;
  conflictingBranch: string;
  jobBranch: string;
  files: string[];
  description: string;
};

export type MergeTaskResult =
  | { status: "merged"; taskId: string; commit: string }
  | {
      status: "conflict";
      taskId: string;
      files: string[];
      /** True when the Job_Branch tip is the same commit as before the attempt. */
      jobBranchUnchanged: boolean;
      reconcile: ReconcileRequest;
    }
  | { status: "not_verified"; taskId: string; reason: string }
  | { status: "failed"; taskId: string; reason: string; jobBranchUnchanged: boolean };

export type VerifyAndMergeResult = {
  verification: VerifyResult;
  /** Present only when the decision was merge. */
  merge?: MergeTaskResult;
};

export type ReconcileWorktreeResult =
  | {
      ok: true;
      path: string;
      branch: string;
      /** Files left in conflict inside the reconcile Worktree for the agent to resolve. */
      conflictFiles: string[];
    }
  | { ok: false; reason: string };

export type MergeInOrderResult = {
  order: string[];
  results: MergeTaskResult[];
  /** Tasks not attempted because an earlier merge did not complete. */
  skipped: string[];
};

/** A request that must wait for Approval. The manager never performs these on its own. */
export type PendingApproval = {
  state: "waiting_approval";
  /** Action kind understood by `classifyAction`. */
  kind: string;
  reason: string;
  description: string;
};

export type JobMergeApproval = { granted: boolean; decidedAt?: number };

export type ApplyJobMergeResult =
  | { status: "merged"; commit: string }
  | { status: "not_approved" }
  | { status: "conflict"; files: string[] }
  | { status: "failed"; reason: string };

export type CleanupResult = {
  removed: string[];
  /** Worktrees left in place, with the reason. Their branches are kept too (Req 9.11). */
  kept: { path: string; reason: string }[];
  /** Message for the user when something was kept; null otherwise. */
  message: string | null;
};
