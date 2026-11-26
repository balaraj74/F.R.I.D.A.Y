import path from "node:path";

import { DEFAULT_WORKTREE_ROOT, worktreePath } from "./logic.js";

/**
 * Branch and path naming for the worktree manager (Requirements 9.1, 15.x).
 * Ids are percent-encoded so every segment is a valid git ref component and a valid path
 * segment, and distinct ids always map to distinct names.
 */

/** Characters `encodeURIComponent` leaves alone that git refs or paths must not contain or confuse. */
const EXTRA_ESCAPES = /[.!'()*~]/g;

export function encodeRefSegment(kind: string, id: string): string {
  if (id.length === 0) {
    throw new Error(`${kind} must not be empty`);
  }
  return encodeURIComponent(id).replace(
    EXTRA_ESCAPES,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Branch that accumulates the merged work of one Job. */
export function jobBranchName(jobId: string): string {
  return `friday/job/${encodeRefSegment("jobId", jobId)}`;
}

/** Dedicated branch for one coding Task. */
export function taskBranchName(jobId: string, taskId: string): string {
  return `friday/task/${encodeRefSegment("jobId", jobId)}/${encodeRefSegment("taskId", taskId)}`;
}

/**
 * Directory that holds every Worktree of a Job. Segment names derived by `worktreePath` never
 * start with `%` followed by a non-hex pair, so the reserved names below cannot collide with a Task.
 */
export function jobWorktreeDir(jobId: string, root: string = DEFAULT_WORKTREE_ROOT): string {
  return path.dirname(worktreePath(jobId, "x", root));
}

/** Worktree where the Job_Branch is checked out so Task branches can be merged into it. */
export function integrationWorktreePath(
  jobId: string,
  root: string = DEFAULT_WORKTREE_ROOT,
): string {
  return path.join(jobWorktreeDir(jobId, root), "%integration");
}

/** Short-lived Worktree used to merge the Job_Branch into a user branch that is not checked out. */
export function finalMergeWorktreePath(
  jobId: string,
  root: string = DEFAULT_WORKTREE_ROOT,
): string {
  return path.join(jobWorktreeDir(jobId, root), "%final");
}

/**
 * Validates a branch name that came from outside (the user's branch, a base branch) before it is
 * passed to git. Stricter than git itself: it must not start with `-`, so it cannot be read as an option.
 */
export function assertSafeBranchName(name: string): void {
  const ok =
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("/.") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock");
  if (!ok) {
    throw new Error(`Unsafe branch name: ${JSON.stringify(name)}`);
  }
}
