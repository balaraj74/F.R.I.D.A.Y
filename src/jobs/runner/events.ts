// Event types appended by the Step_Runner and Watchdog, in addition to the lifecycle types in
// `EVENT_TYPES` (src/jobs/store/project.ts). The projection ignores unknown types for state
// but still records them in the timeline, so these are safe to add (see `applyEvent`).

export const RUNNER_EVENT_TYPES = {
  /** One attempt failed (empty reply, proxy unreachable, timeout or error). Req 6.7, 6.8. */
  attemptFailed: "attempt-failed",
  /** The Watchdog cancelled a Step that produced no output. Req 6.6. */
  stall: "stall",
  /** A retry was scheduled after a delay. Req 6.6, 6.8. */
  stepRetry: "step-retry",
  /** A per-Step or per-Job Budget limit was exceeded. Req 6.4. */
  budgetExceeded: "budget-exceeded",
  /** `timeoutSeconds` was missing or invalid and the 600s default was used. Req 6.12. */
  invalidTimeout: "invalid-timeout",
  /** progress.md could not be updated; the Step result is still recorded. Req 6.2. */
  progressWriteFailed: "progress-write-failed",
  /** The Lease expired while the Step was running, so the runner stopped it. Req 5.8. */
  leaseLost: "lease-lost",
} as const;
