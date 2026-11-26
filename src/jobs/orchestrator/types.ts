// Shared types for the pure orchestrator logic (Requirement 7).
export const ROLES = ["researcher", "builder", "operator", "reviewer", "verifier"] as const;
export type Role = (typeof ROLES)[number];

export type AcceptanceCheck =
  | { type: "tests_pass"; command: string }
  | { type: "file_exists"; path: string }
  | { type: "exit_code"; command: string; expected: number }
  | { type: "rubric"; items: string[] };

export type TaskDef = {
  id: string;
  role: Role;
  dependsOn: string[];
  acceptanceChecks: AcceptanceCheck[];
  /**
   * Ids of upstream Tasks whose output this Task needs in order to proceed (set by the Planner).
   * Optional and backwards compatible: when absent, no output is required. If an approval for a
   * listed Task is denied, `denyOutcome` marks it failed instead of skipped (Requirement 8.8).
   */
  requiresOutputFrom?: string[];
};

export type TaskState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

/** Evidence the Verifier recorded for one Acceptance_Check. `type` must match the check it backs. */
export type Evidence =
  | { type: "tests_pass"; exitCode: number }
  | { type: "file_exists"; exists: boolean }
  | { type: "exit_code"; exitCode: number }
  | { type: "rubric"; metItems: string[] };

export type CheckResult = "pass" | "fail" | "no-evidence";
export type VerificationOutcome = "done" | "retry" | "failed";
