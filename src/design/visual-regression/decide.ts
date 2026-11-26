export type ScreenshotResult = "pass" | "fail-diff" | "fail-missing-baseline";

/**
 * Decide the outcome for one (Screen, Window_Size) capture.
 *
 * - No baseline: "fail-missing-baseline" (checked first; the diff count is meaningless without one).
 * - Otherwise the first `aaTolerancePixels` differing pixels are treated as anti-aliasing noise.
 *   Any remaining differing pixel is "fail-diff"; zero remaining is "pass".
 */
export function decideScreenshotResult(
  diffPixels: number,
  aaTolerancePixels: number,
  baselineExists: boolean,
): ScreenshotResult {
  if (!baselineExists) {
    return "fail-missing-baseline";
  }
  return diffPixels - aaTolerancePixels > 0 ? "fail-diff" : "pass";
}
