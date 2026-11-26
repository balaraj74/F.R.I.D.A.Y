/**
 * Digest schedule and text (Requirement 13.2). A Digest lists every Job whose status changed since
 * the previous Digest, with its identifier, final or current status and completion time.
 */

import { localClock, parseTimeOfDaySec, resolveTimeZone, type Resolved } from "./quiet-hours.js";

export type DigestConfig = {
  /** Time of day to deliver the Digest, 24h "HH:MM". */
  time: string;
  /** "user" (default), "local" or an IANA zone id. */
  timezone?: string;
};

export type ResolvedDigestSchedule = { dueSec: number; timeZone: string };

/** A Job status change reported to the Notifier. */
export type DigestEntry = {
  jobId: string;
  /** Final or current status. */
  status: string;
  /** Completion time in epoch ms; absent while the Job has not completed. */
  completedAtMs?: number;
  /** When the status change was recorded, epoch ms. */
  changedAtMs: number;
};

const DAY_SEC = 24 * 60 * 60;

export function resolveDigestSchedule(
  config: DigestConfig,
  userTimezone?: string,
): Resolved<ResolvedDigestSchedule> {
  const dueSec = parseTimeOfDaySec(config.time, false);
  if (dueSec === null) return { ok: false, error: `invalid digest time "${config.time}"` };
  return { ok: true, value: { dueSec, timeZone: resolveTimeZone(config.timezone, userTimezone) } };
}

/**
 * Milliseconds until a Digest is due, given the local date of the last one delivered (or skipped).
 * Returns 0 when today's time has been reached and today's Digest is still outstanding, so a late
 * timer still produces exactly one Digest for that day.
 */
export function msUntilDigestDue(
  nowMs: number,
  schedule: ResolvedDigestSchedule,
  lastDigestDateKey: string | undefined,
): number {
  const { dateKey, secondsOfDay } = localClock(nowMs, schedule.timeZone);
  const subSecondMs = ((nowMs % 1000) + 1000) % 1000;
  let diffSec: number;
  if (lastDigestDateKey !== dateKey && secondsOfDay >= schedule.dueSec) diffSec = 0;
  else if (secondsOfDay < schedule.dueSec) diffSec = schedule.dueSec - secondsOfDay;
  else diffSec = DAY_SEC - secondsOfDay + schedule.dueSec;
  return diffSec === 0 ? 0 : Math.max(0, diffSec * 1000 - subSecondMs);
}

export function formatDigestText(entries: readonly DigestEntry[]): string {
  if (entries.length === 0) return "Digest: no Job status changes since the previous Digest.";
  const lines = [`Digest: ${entries.length} Job status change(s) since the previous Digest`];
  for (const e of entries) {
    const done =
      e.completedAtMs === undefined
        ? "not completed"
        : `completed ${new Date(e.completedAtMs).toISOString()}`;
    lines.push(`- ${e.jobId}: ${e.status} (${done})`);
  }
  return lines.join("\n");
}
