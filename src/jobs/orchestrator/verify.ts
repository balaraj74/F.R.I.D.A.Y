import type { AcceptanceCheck, CheckResult, Evidence, VerificationOutcome } from "./types.js";

/** A Task gets this many verification attempts before it is marked failed (Req 7.10, 7.11). */
export const MAX_VERIFICATION_ATTEMPTS = 3;

/**
 * Judges one Acceptance_Check against the Evidence recorded for it (Requirement 7.7).
 * Missing evidence, or evidence recorded for a different check type, is "no-evidence".
 */
export function evaluateCheck(check: AcceptanceCheck, evidence?: Evidence): CheckResult {
  if (!evidence || evidence.type !== check.type) return "no-evidence";
  switch (check.type) {
    case "tests_pass":
      return evidence.type === "tests_pass" && evidence.exitCode === 0 ? "pass" : "fail";
    case "exit_code":
      return evidence.type === "exit_code" && evidence.exitCode === check.expected
        ? "pass"
        : "fail";
    case "file_exists":
      return evidence.type === "file_exists" && evidence.exists ? "pass" : "fail";
    case "rubric": {
      if (evidence.type !== "rubric") return "fail";
      const met = new Set(evidence.metItems);
      return check.items.every((item) => met.has(item)) ? "pass" : "fail";
    }
  }
}

/**
 * Decides what happens to a Task after a verification attempt (Requirements 7.9-7.11).
 * `attempt` is the 1-based number of verification attempts made so far, including the one
 * that produced `results`. The Task is done only when there is at least one result and
 * every result is "pass"; otherwise it returns to running while `attempt` is below
 * MAX_VERIFICATION_ATTEMPTS and fails afterwards.
 */
export function taskVerificationOutcome(
  results: readonly CheckResult[],
  attempt: number,
): VerificationOutcome {
  if (results.length > 0 && results.every((r) => r === "pass")) return "done";
  return attempt < MAX_VERIFICATION_ATTEMPTS ? "retry" : "failed";
}
