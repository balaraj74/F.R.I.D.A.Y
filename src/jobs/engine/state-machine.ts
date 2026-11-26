import type { DatabaseSync } from "node:sqlite";

import {
  appendEvent,
  EVENT_TYPES,
  EventLogWriteError,
  JOB_STATES,
  loadEvents,
  projectJobState,
  type AppendedEvent,
  type JobState,
} from "../store/index.js";
import { err, ok, type Result } from "./types.js";

/**
 * Single source of truth for Job state transitions (Req 5.4-5.6, 8.10-8.13).
 * A state that is not a key, or a target not in its array, is rejected.
 * `paused` is the extended state from the design's Error Handling table.
 * Req 5.4 allows "any non-terminal state to cancelled", so `pending` can be cancelled too.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  pending: ["running", "cancelled"],
  running: ["waiting_approval", "verifying", "failed", "cancelled", "paused"],
  waiting_approval: ["running", "cancelled"],
  verifying: ["done", "running", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_JOB_STATES: readonly JobState[] = ["done", "failed", "cancelled"];

export type TransitionError =
  | { kind: "not-found"; jobId: string }
  | { kind: "not-allowed"; jobId: string; from: JobState; to: string }
  | { kind: "write-failed"; jobId: string; message: string };

/** Pure table lookup. Unknown states on either side are never allowed. */
export function canTransition(from: JobState, to: JobState): boolean {
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, from)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type RequestTransitionOptions = {
  /** Recorded on the event and surfaced as the Job's `stateReason`. */
  reason?: string;
  /** Event timestamp; defaults to `Date.now()` in the store. */
  nowMs?: number;
};

/**
 * Validates a Job state change against the log-derived current state and appends one
 * `job-state-changed` event. Rejections (unknown job, disallowed transition, write failure)
 * leave the Event_Log untouched, so state is unchanged (Req 5.2, 5.5, 5.6).
 */
export function requestTransition(
  db: DatabaseSync,
  jobId: string,
  to: JobState,
  opts: RequestTransitionOptions = {},
): Result<AppendedEvent, TransitionError> {
  const job = projectJobState(loadEvents(db, jobId)).jobs[jobId];
  if (!job) return err({ kind: "not-found", jobId });

  const from = job.state;
  if (!(JOB_STATES as readonly string[]).includes(to) || !canTransition(from, to)) {
    return err({ kind: "not-allowed", jobId, from, to });
  }

  try {
    const event = appendEvent(db, {
      jobId,
      type: EVENT_TYPES.jobStateChanged,
      payload: { from, to, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) },
      ...(opts.nowMs !== undefined ? { createdAtMs: opts.nowMs } : {}),
    });
    return ok(event);
  } catch (e) {
    if (e instanceof EventLogWriteError) {
      return err({ kind: "write-failed", jobId, message: e.message });
    }
    throw e;
  }
}
