/** Recorded Off_System_Value count, committed so `pnpm design:lint` can compare against it. */
export interface LintBaseline {
  version: 1;
  /** Off_System_Values found when the baseline was recorded. */
  count: number;
  /** ISO-8601 timestamp of the recording. */
  recordedAt: string;
}

export type ParseBaselineResult =
  | { ok: true; baseline: LintBaseline }
  | { ok: false; reason: string };

/** Validates the text of a baseline file. */
export function parseLintBaseline(raw: string): ParseBaselineResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, reason: "expected a JSON object" };
  }
  const { version, count, recordedAt } = data as Record<string, unknown>;
  if (version !== 1) {
    return { ok: false, reason: "version must be 1" };
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return { ok: false, reason: "count must be a non-negative integer" };
  }
  if (typeof recordedAt !== "string" || recordedAt === "") {
    return { ok: false, reason: "recordedAt must be a non-empty string" };
  }
  return { ok: true, baseline: { version: 1, count, recordedAt } };
}

/** Stable, diff-friendly serialisation (trailing newline). */
export function serializeLintBaseline(baseline: LintBaseline): string {
  return `${JSON.stringify({ version: 1, count: baseline.count, recordedAt: baseline.recordedAt }, null, 2)}\n`;
}
