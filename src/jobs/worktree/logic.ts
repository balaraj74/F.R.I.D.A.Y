import path from "node:path";

/**
 * Pure decision logic for safe parallel coding (Requirements 9.3, 9.5, 9.6, 9.12).
 * No I/O: git, test runs and merges live in the worktree manager.
 */

/** Maximum failed verification attempts before a coding Task moves to failed (Req 9.6). */
export const MAX_VERIFY_ATTEMPTS = 3;

/** Default directory (relative to the repository root) that holds Task Worktrees. */
export const DEFAULT_WORKTREE_ROOT = ".friday/worktrees";

/**
 * Encode an id as one safe path segment. `encodeURIComponent` is injective and removes
 * separators; `.` is encoded too so ids like `..` cannot escape the root.
 */
function encodeSegment(kind: string, id: string): string {
  if (id.length === 0) {
    throw new Error(`${kind} must not be empty`);
  }
  return encodeURIComponent(id).replaceAll(".", "%2E");
}

/**
 * Deterministic, unique Worktree path for a Task: `<root>/<jobId>/<taskId>`.
 * Distinct (jobId, taskId) pairs always map to distinct paths, and the result always
 * stays inside `root`. A relative `root` yields a path relative to the repository root.
 */
export function worktreePath(
  jobId: string,
  taskId: string,
  root: string = DEFAULT_WORKTREE_ROOT,
): string {
  return path.join(root, encodeSegment("jobId", jobId), encodeSegment("taskId", taskId));
}

export type VerifyDecision = "merge" | "retry" | "failed";

/**
 * Decide what happens after a verification attempt (Req 9.5, 9.6).
 * `attempt` is the 1-based number of the attempt that just finished.
 * - both checks passed: merge
 * - otherwise, fewer than 3 attempts used: retry (Task returns to running)
 * - otherwise: failed
 */
export function verifyOutcome(
  testsPassed: boolean,
  lintPassed: boolean,
  attempt: number,
): VerifyDecision {
  if (testsPassed && lintPassed) {
    return "merge";
  }
  // Negated comparison so a NaN attempt fails closed instead of retrying forever.
  return attempt < MAX_VERIFY_ATTEMPTS ? "retry" : "failed";
}

/** Minimal structural view of a Task needed for merge ordering. */
export type MergeableTask = {
  id: string;
  dependsOn: readonly string[];
};

/**
 * Order done Tasks for merging into the Job_Branch so every Task merges after the
 * Tasks it depends on. Dependencies outside `doneTasks` are ignored. Ties keep input
 * order, so the result is deterministic. Duplicate ids keep their first occurrence.
 * Throws if the dependencies among `doneTasks` contain a cycle.
 */
export function planMergeOrder(doneTasks: readonly MergeableTask[]): string[] {
  const seen = new Set<string>();
  const pending: MergeableTask[] = [];
  for (const task of doneTasks) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      pending.push(task);
    }
  }

  const order: string[] = [];
  const emitted = new Set<string>();
  while (pending.length > 0) {
    const index = pending.findIndex((task) =>
      task.dependsOn.every((dep) => dep === task.id || emitted.has(dep) || !seen.has(dep)),
    );
    if (index === -1) {
      throw new Error(
        `Cyclic dependencies among done tasks: ${pending.map((task) => task.id).join(", ")}`,
      );
    }
    const [next] = pending.splice(index, 1);
    emitted.add(next.id);
    order.push(next.id);
  }
  return order;
}

/** Where a Task may write. */
export type WriteScope = {
  /** Repository root; relative `worktree` and `declaredPaths` resolve against it. */
  repoRoot: string;
  /** The Task's Worktree directory (see `worktreePath`). */
  worktree: string;
  /** Repository paths the Task declared it may modify, in addition to its Worktree. */
  declaredPaths?: readonly string[];
};

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") {
    return true;
  }
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Write-path guard (Req 9.12): a write is allowed iff the target lies within the Task's
 * Worktree or one of its declared paths. Paths are normalized lexically, so `..` segments
 * cannot escape. A relative `target` resolves against the Worktree (the Task's working
 * directory). Symlinks are not followed here; callers that touch the filesystem should
 * resolve real paths before calling.
 */
export function isWriteAllowed(target: string, scope: WriteScope): boolean {
  if (target.length === 0 || target.includes("\0")) {
    return false;
  }
  const worktree = path.resolve(scope.repoRoot, scope.worktree);
  const resolvedTarget = path.resolve(worktree, target);
  if (isWithin(worktree, resolvedTarget)) {
    return true;
  }
  return (scope.declaredPaths ?? []).some((declared) => {
    if (declared.length === 0 || declared.includes("\0")) {
      return false;
    }
    return isWithin(path.resolve(scope.repoRoot, declared), resolvedTarget);
  });
}

/** Thrown by `assertWriteAllowed` when a write falls outside the Task's scope. */
export class WriteDeniedError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(
      `Write denied: ${JSON.stringify(target)} is outside the task worktree and declared paths`,
    );
    this.name = "WriteDeniedError";
    this.target = target;
  }
}

/** Throwing variant of `isWriteAllowed`. */
export function assertWriteAllowed(target: string, scope: WriteScope): void {
  if (!isWriteAllowed(target, scope)) {
    throw new WriteDeniedError(target);
  }
}
