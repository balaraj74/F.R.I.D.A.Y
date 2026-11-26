/** Exit code for "violations above baseline". Unreadable inputs use 2 (see the CLI entry). */
export type LintExitCode = 0 | 1;

/**
 * Compare the Off_System_Value count with the recorded baseline.
 * Above the baseline is a failure (1); at or below it is a pass (0).
 */
export function decideExit(
  violationCount: number,
  baselineCount: number,
): { exitCode: LintExitCode } {
  return { exitCode: violationCount > baselineCount ? 1 : 0 };
}
