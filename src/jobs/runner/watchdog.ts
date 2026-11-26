// Watchdog (Requirement 6.6): detects a Step that has produced no output for the stall timeout.
// It only reports the stall. The Step_Runner cancels the attempt, appends the `stall` event and
// schedules the retry, so all Event_Log writes stay in one place.
import type { RunnerClock } from "./deps.js";

/** Stall timeout used when none is configured (Requirement 6.6). */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 120;

/** A positive, finite number of seconds, else the 120s default. */
export function resolveStallTimeoutSeconds(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) && input > 0
    ? input
    : DEFAULT_STALL_TIMEOUT_SECONDS;
}

export interface Watchdog {
  /** Record output. Restarts the stall timer. Ignored after a stall or `stop()`. */
  touch(): void;
  /** Disarm the timer. Safe to call repeatedly. */
  stop(): void;
}

/**
 * Starts a Watchdog already armed (start counts as the first output). `onStall` fires once,
 * with the idle time in ms, when `stallTimeoutMs` passes without a `touch()`.
 */
export function startWatchdog(opts: {
  clock: RunnerClock;
  stallTimeoutMs: number;
  onStall: (idleMs: number) => void;
}): Watchdog {
  const { clock, stallTimeoutMs, onStall } = opts;
  let done = false;
  let cancel: (() => void) | undefined;
  let lastOutputAtMs = clock.now();

  const arm = () => {
    cancel?.();
    cancel = clock.setTimer(() => {
      if (done) return;
      done = true;
      onStall(clock.now() - lastOutputAtMs);
    }, stallTimeoutMs);
  };
  arm();

  return {
    touch() {
      if (done) return;
      lastOutputAtMs = clock.now();
      arm();
    },
    stop() {
      done = true;
      cancel?.();
      cancel = undefined;
    },
  };
}
