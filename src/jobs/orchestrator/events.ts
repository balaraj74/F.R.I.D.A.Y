// Event types appended by the Planner, Orchestrator and Verifier runtime, in addition to the
// lifecycle types in `EVENT_TYPES` (src/jobs/store/project.ts). The projection ignores unknown
// types for state but still records them in the timeline, so these are safe to add.

export const ORCHESTRATOR_EVENT_TYPES = {
  /** A plan attempt was rejected (invalid, timed out or the planner failed). Req 7.2, 7.4. */
  planRejected: "plan-rejected",
  /** A plan passed validation and its Tasks are about to be persisted. Req 7.1. */
  planAccepted: "plan-accepted",
  /** A Task asked for a tool outside its Role's allowlist. Req 7.5. */
  toolDenied: "tool-denied",
  /** A pre-action hook refused an otherwise allowed action (extension point). */
  actionBlocked: "action-blocked",
  /** A Verifier agent was started in a fresh session. Req 7.8. */
  verificationStarted: "verification-started",
  /** Evidence for one Acceptance_Check was recorded. Req 7.9. */
  evidenceRecorded: "evidence-recorded",
  /** Evidence collection for one Acceptance_Check failed or timed out. Req 7.10. */
  evidenceFailed: "evidence-failed",
  /** Outcome of one verification attempt, with per-check results. Req 7.9-7.11. */
  verificationResult: "verification-result",
  /** A Task was flagged as looping; carries the response and action taken. Req 10.3, 10.4. */
  loopFlagged: "loop-flagged",
  /** A Never_Auto_Action was withheld and its Task moved to waiting_approval. Req 8.1. */
  approvalRequested: "approval-requested",
  /** The first decision for a pending approval was applied. Req 8.6. */
  approvalDecision: "approval-decision",
  /** A decision arrived when none was pending (an earlier one won, or the Job was cancelled). Req 8.6. */
  approvalDecisionIgnored: "approval-decision-ignored",
  /** What an applied decision did to the Task: resumed, or skipped/failed with a reason. Req 8.7, 8.8. */
  approvalOutcome: "approval-outcome",
  /** A pending approval was dropped because its Job was cancelled. Req 8.13. */
  approvalDiscarded: "approval-discarded",
  /** The Notifier could not reach any channel or threw. The Task stays in waiting_approval. Req 8.5. */
  approvalNotifyFailed: "approval-notify-failed",
  /** The Proxy answered again, so the interrupted Step is retried once. Req 13.11. */
  proxyRetryScheduled: "proxy-retry-scheduled",
  /** No retry was possible, or the single retry failed, so the Job will fail. Req 13.11. */
  proxyRetryFailed: "proxy-retry-failed",
  /** A Job was picked up again after a Gateway restart; carries what was kept and re-run. Req 13.10. */
  jobAdopted: "job-adopted",
} as const;
