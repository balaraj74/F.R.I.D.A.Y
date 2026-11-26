/**
 * ProxyRestartCoordinator (Requirement 13.11). When the HUD closes and the Proxy restarts, a Step that
 * was talking to the Proxy ends with a "Proxy unreachable" failure. The Orchestrator hands that Step
 * to `awaitRetry`, which waits for the Proxy to respond and then allows exactly one retry. The
 * Orchestrator starts the retry straight away, so it begins well inside the 30s window.
 *
 * Two inputs tell the coordinator the Proxy is back: its own probe (polled every `pollIntervalMs`, at
 * most 10s) and the Health_Monitor's `onProxyEvent` events passed to `handleHealthEvent`, which also
 * report when the monitor gave up (3 failed restarts). If the Proxy does not respond, or the retry
 * fails, `retryFailed` records the outcome and tells the user; the Orchestrator then fails the Job.
 *
 * Probe, notifier, clock and event database are injected, so tests run with a fake clock and Proxy.
 */
import type { DatabaseSync } from "node:sqlite";

import type {
  ProxyRetryDecision,
  ProxyRetryRequest,
  StepProxyRecovery,
} from "../orchestrator/runtime-types.js";
import { appendEvent } from "../store/log.js";
import {
  HEALTH_EVENT_JOB_ID,
  healthSystemClock,
  type HealthClock,
  type ProxyHealthEvent,
} from "./health.js";

/** The retry must start within this long after the Proxy responds (Req 13.11). */
export const PROXY_RETRY_WINDOW_MS = 30_000;
export const DEFAULT_PROXY_POLL_INTERVAL_MS = 1_000;
/** Polling slower than this could eat into the 30s retry window. */
export const MAX_PROXY_POLL_INTERVAL_MS = 10_000;
export const PROXY_RESPONSE_PROBE_TIMEOUT_MS = 10_000;
/** How long a Step waits for the Proxy before the Job is failed. */
export const DEFAULT_PROXY_WAIT_MS = 5 * 60_000;

export type ProxyRestartCoordinatorDeps = {
  /** Event_Log database that receives `health.proxy.step-retry-*` events. */
  db: DatabaseSync;
  /** Resolves true when the Proxy answers. A rejection, `false` or a timeout means it does not. */
  probeProxy: () => Promise<boolean>;
  /** Tells the user. `Notifier` satisfies this (`notify(text)`). */
  notifier: { notify(text: string): unknown };
  clock?: HealthClock;
  pollIntervalMs?: number;
  /** Longest wait for the Proxy per Step. */
  maxWaitMs?: number;
};

function positive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function stepKey(req: Pick<ProxyRetryRequest, "jobId" | "stepId">): string {
  return `${req.jobId}\u0000${req.stepId}`;
}

export class ProxyRestartCoordinator implements StepProxyRecovery {
  private readonly clock: HealthClock;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  /** True after the Health_Monitor gave up and until the Proxy answers again. */
  private gaveUp = false;
  /** Steps already granted their one retry. */
  private readonly retried = new Set<string>();
  private readonly wakers = new Set<() => void>();

  constructor(private readonly deps: ProxyRestartCoordinatorDeps) {
    this.clock = deps.clock ?? healthSystemClock;
    this.pollMs = Math.min(
      positive(deps.pollIntervalMs, DEFAULT_PROXY_POLL_INTERVAL_MS),
      MAX_PROXY_POLL_INTERVAL_MS,
    );
    this.maxWaitMs = positive(deps.maxWaitMs, DEFAULT_PROXY_WAIT_MS);
  }

  /** Pass this to `HealthMonitorDeps.onProxyEvent`. */
  handleHealthEvent = (e: ProxyHealthEvent): void => {
    if (e.kind === "gave-up") this.gaveUp = true;
    else if (e.kind === "restarted" || e.kind === "recovered") this.gaveUp = false;
    for (const wake of this.wakers) wake();
  };

  async awaitRetry(req: ProxyRetryRequest): Promise<ProxyRetryDecision> {
    const key = stepKey(req);
    if (this.retried.has(key)) {
      return { retry: false, reason: "the Step was already retried once after a Proxy restart" };
    }
    const startedAtMs = this.clock.now();
    for (;;) {
      if (req.signal.aborted) return { retry: false, reason: "stopped" };
      const responds = await this.proxyResponds();
      if (!responds && this.gaveUp) {
        return { retry: false, reason: "the Proxy is down: restarts kept failing" };
      }
      if (responds) {
        if (req.signal.aborted) return { retry: false, reason: "stopped" };
        const respondedAtMs = this.clock.now();
        this.retried.add(key);
        this.record("health.proxy.step-retry-ready", {
          jobId: req.jobId,
          stepId: req.stepId,
          respondedAtMs,
          retryByMs: respondedAtMs + PROXY_RETRY_WINDOW_MS,
        });
        return { retry: true, respondedAtMs };
      }
      if (this.clock.now() - startedAtMs >= this.maxWaitMs) {
        return {
          retry: false,
          reason: `the Proxy did not respond within ${Math.round(this.maxWaitMs / 1000)}s`,
        };
      }
      await this.waitForWake(req.signal);
    }
  }

  async retryFailed(req: ProxyRetryRequest): Promise<void> {
    this.record("health.proxy.step-retry-failed", {
      jobId: req.jobId,
      taskId: req.taskId,
      stepId: req.stepId,
      reason: req.reason,
    });
    try {
      await this.deps.notifier.notify(
        `Job ${req.jobId} failed: step ${req.stepId} could not continue after the Proxy restarted (${req.reason}).`,
      );
    } catch (err) {
      this.record("health.proxy.step-retry-notify-failed", {
        jobId: req.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Probe with the monitor's 10s deadline; any error counts as "not responding". */
  private proxyResponds(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.clock.setTimeout(() => resolve(false), PROXY_RESPONSE_PROBE_TIMEOUT_MS);
      this.deps.probeProxy().then(
        (ok) => {
          this.clock.clearTimeout(timer);
          resolve(ok === true);
        },
        () => {
          this.clock.clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  /** Resolves after one poll interval, or sooner on a health event or when `signal` aborts. */
  private waitForWake(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.clock.clearTimeout(timer);
        this.wakers.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = this.clock.setTimeout(done, this.pollMs);
      this.wakers.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private record(type: string, payload: Record<string, unknown>): void {
    try {
      appendEvent(this.deps.db, {
        jobId: HEALTH_EVENT_JOB_ID,
        type,
        payload,
        createdAtMs: this.clock.now(),
      });
    } catch {
      // A failed log write must not block the retry or the notification.
    }
  }
}
