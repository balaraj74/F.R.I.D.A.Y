/**
 * Time-of-day helpers for the Notifier (Requirements 13.2 to 13.4): the Quiet_Hours window and the
 * daily Digest time. Everything here is pure and takes the current time as an argument, so the
 * Notifier's injected clock (and fake timers in tests) drive it.
 *
 * Time zones follow the heartbeat active-hours convention in `src/infra/heartbeat-runner.ts`:
 * "user" (the default, `agents.defaults.userTimezone` or the host zone), "local" (host zone), or an
 * IANA zone id. An unknown zone id falls back to the user zone.
 */

import { resolveUserTimezone } from "../../agents/date-time.js";

/** How approval requests behave while Quiet_Hours are active (Requirement 13.4). */
export type QuietHoursApprovalSetting = "allow" | "hold";

export type QuietHoursConfig = {
  /** Start of the window, 24h "HH:MM". */
  start: string;
  /** End of the window, 24h "HH:MM" (exclusive). "24:00" is allowed. May be earlier than `start`. */
  end: string;
  /** "user" (default), "local" or an IANA zone id. */
  timezone?: string;
  /** "allow" delivers approval requests during Quiet_Hours, "hold" delays them until the end. */
  approvals: QuietHoursApprovalSetting;
};

export type ResolvedQuietHours = {
  startSec: number;
  endSec: number;
  timeZone: string;
  approvals: QuietHoursApprovalSetting;
};

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

const TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
const DAY_SEC = 24 * 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
/** Longest a single wait may be once the target is near. Keeps delivery well inside 60s. */
export const MAX_POLL_MS = 30_000;

/** Seconds since local midnight for "HH:MM", or null. "24:00" is accepted only when `allow24`. */
export function parseTimeOfDaySec(raw: unknown, allow24: boolean): number | null {
  if (typeof raw !== "string") return null;
  const m = TIME_PATTERN.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour === 24) return allow24 && minute === 0 ? DAY_SEC : null;
  return (hour * 60 + minute) * 60;
}

export function resolveTimeZone(raw: string | undefined, userTimezone?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user") return resolveUserTimezone(userTimezone);
  if (trimmed === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host?.trim() || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return resolveUserTimezone(userTimezone);
  }
}

/** Local calendar date ("YYYY-MM-DD") and seconds since local midnight in `timeZone`. */
export function localClock(
  nowMs: number,
  timeZone: string,
): { dateKey: string; secondsOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const hour = Number(map.hour) % 24;
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    secondsOfDay: hour * 3600 + Number(map.minute) * 60 + Number(map.second),
  };
}

/** Validate a Quiet_Hours config. Equal start and end is rejected as ambiguous. */
export function resolveQuietHours(
  config: QuietHoursConfig,
  userTimezone?: string,
): Resolved<ResolvedQuietHours> {
  const startSec = parseTimeOfDaySec(config.start, false);
  const endSec = parseTimeOfDaySec(config.end, true);
  if (startSec === null) return { ok: false, error: `invalid quiet-hours start "${config.start}"` };
  if (endSec === null) return { ok: false, error: `invalid quiet-hours end "${config.end}"` };
  if (startSec === endSec) return { ok: false, error: "quiet-hours start and end must differ" };
  if (config.approvals !== "allow" && config.approvals !== "hold") {
    return {
      ok: false,
      error: `invalid quiet-hours approval setting "${String(config.approvals)}"`,
    };
  }
  return {
    ok: true,
    value: {
      startSec,
      endSec,
      timeZone: resolveTimeZone(config.timezone, userTimezone),
      approvals: config.approvals,
    },
  };
}

/** True when `nowMs` falls inside the window. Handles windows that span midnight (start > end). */
export function isQuietAt(nowMs: number, q: ResolvedQuietHours): boolean {
  const { secondsOfDay: s } = localClock(nowMs, q.timeZone);
  if (q.endSec > q.startSec) return s >= q.startSec && s < q.endSec;
  return s >= q.startSec || s < q.endSec;
}

/** Milliseconds until the active window ends; 0 when it is not active. */
export function msUntilQuietEnd(nowMs: number, q: ResolvedQuietHours): number {
  if (!isQuietAt(nowMs, q)) return 0;
  const { secondsOfDay: s } = localClock(nowMs, q.timeZone);
  let diff = q.endSec - s;
  if (diff <= 0) diff += DAY_SEC; // window started yesterday evening, ends after midnight
  return Math.max(0, diff * 1000 - (((nowMs % 1000) + 1000) % 1000));
}

/**
 * Delay for the next wake-up toward a target `untilMs` away. Far targets sleep most of the way, near
 * targets poll every 30s. Each wake re-reads the zone's wall clock, so a DST change moves delivery
 * by at most one poll interval instead of up to an hour.
 */
export function boundedDelay(untilMs: number): number {
  if (untilMs <= 0) return 0;
  if (untilMs > 2 * HOUR_MS) return untilMs - HOUR_MS;
  return Math.min(untilMs, MAX_POLL_MS);
}
