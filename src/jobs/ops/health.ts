/**
 * Health_Monitor (Requirements 13.5-13.8). Polls Proxy health, free disk space and internet
 * reachability, applies the remedies below and records every state change in the Event_Log.
 *
 * - Proxy (13.5, 13.6): probed every 10s. A probe that fails, throws or does not answer within 10s is a
 *   missed check, and the Proxy restart starts immediately (inside the 30s budget). A restart fails when
 *   it rejects, takes over 30s, or the Proxy still fails the probe afterwards. After 3 consecutive failed
 *   restarts the monitor stops retrying, notifies the user and logs each failed attempt.
 * - Disk (13.7): below the threshold the user is notified and `canCreateJob()` refuses new Jobs until
 *   free space is back at or above the threshold. Running Jobs are never touched.
 * - Network (13.8): after 10s of lost connectivity `pauseNetworkSteps` runs. Once connectivity returns,
 *   `resumeNetworkSteps` runs on the next poll (at most 30s later).
 *
 * Every external is injected (probes, restart, notify, hooks, clock), so behavior is testable with a
 * fake clock. The repo has no single supervised-Proxy API yet, so the Proxy restart has no default
 * adapter: the Gateway wires `restartProxy` to whatever starts the local model proxy. Disk, network
 * and HTTP health adapters are provided below.
 */
import fs from "node:fs";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { appendEvent } from "../store/log.js";
import type { NewEvent } from "../store/types.js";

/** Timer and clock seam (structurally the same as the Notifier's clock). */
export type HealthClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Looks up the global timers at call time, so test fake timers are honored. */
export const healthSystemClock: HealthClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Event_Log job id that owns health events, which belong to no Job. */
export const HEALTH_EVENT_JOB_ID = "ops:health";

export const PROXY_CHECK_INTERVAL_MS = 10_000;
export const PROXY_PROBE_TIMEOUT_MS = 10_000;
export const PROXY_RESTART_TIMEOUT_MS = 30_000;
export const PROXY_MAX_RESTART_FAILURES = 3;
export const DEFAULT_RESTART_RETRY_DELAY_MS = 2_000;
export const DISK_CHECK_INTERVAL_MS = 10_000;
/** Notification must land within 60s (13.7), so the disk poll never runs slower than this. */
export const MAX_DISK_CHECK_INTERVAL_MS = 30_000;
export const NETWORK_CHECK_INTERVAL_MS = 2_000;
export const NETWORK_LOSS_PAUSE_AFTER_MS = 10_000;
/** Resume must land within 30s of recovery (13.8), so the network poll never runs slower than this. */
export const MAX_NETWORK_CHECK_INTERVAL_MS = 30_000;
export const NETWORK_PROBE_TIMEOUT_MS = 5_000;

export type HealthNotification = {
  kind: "proxy-down" | "disk-low";
  text: string;
  atMs: number;
};

/**
 * Proxy state changes the Health_Monitor reports through `onProxyEvent`. "restarted" means a restart
 * succeeded and the follow-up probe passed, "recovered" means the Proxy answered again after the
 * monitor gave up, and "gave-up" means 3 restarts failed in a row (Req 13.5, 13.6, 13.11).
 */
export type ProxyHealthEvent = {
  kind: "down" | "restarted" | "recovered" | "gave-up";
  atMs: number;
};

export type JobCreationGate =
  | { allowed: true }
  | {
      allowed: false;
      reason: "low-disk";
      freeBytes: number;
      thresholdBytes: number;
      message: string;
    };

export type HealthMonitorDeps = {
  /** Event_Log database that receives health events. */
  db: DatabaseSync;
  /** Resolves true when the Proxy is healthy. A rejection or `false` is a missed check. */
  probeProxy: () => Promise<boolean>;
  /** Restarts the Proxy. Rejects (or takes over `restartTimeoutMs`) when the restart fails. */
  restartProxy: () => Promise<void>;
  /** Free bytes on the volume that holds Job data. */
  freeDiskBytes: () => Promise<number>;
  /** Resolves true while the internet is reachable. */
  probeNetwork: () => Promise<boolean>;
  notify: (n: HealthNotification) => void | Promise<void>;
  /** Observes Proxy state changes, e.g. for the ProxyRestartCoordinator. A throw is ignored. */
  onProxyEvent?: (e: ProxyHealthEvent) => void;
  /** Pauses every running Step that needs the network, remembering where each stopped. */
  pauseNetworkSteps: () => void | Promise<void>;
  /** Resumes the paused Steps from the point where they paused. */
  resumeNetworkSteps: () => void | Promise<void>;
  /** Free-space floor in bytes. Below it new Jobs are blocked. */
  diskThresholdBytes: number;
  clock?: HealthClock;
  proxyCheckIntervalMs?: number;
  diskCheckIntervalMs?: number;
  networkCheckIntervalMs?: number;
  restartRetryDelayMs?: number;
};

export class HealthMonitor {
  private readonly clock: HealthClock;
  private readonly proxyIntervalMs: number;
  private readonly diskIntervalMs: number;
  private readonly networkIntervalMs: number;
  private readonly retryDelayMs: number;

  private running = false;
  private timers = new Set<unknown>();

  private proxyGaveUp = false;
  private proxyDownNotified = false;

  private disk: { low: boolean; freeBytes: number } = { low: false, freeBytes: Infinity };

  private networkLostSinceMs: number | null = null;
  private networkPaused = false;
  private networkPauseTimer: unknown = null;

  constructor(private readonly deps: HealthMonitorDeps) {
    this.clock = deps.clock ?? healthSystemClock;
    this.proxyIntervalMs = positive(deps.proxyCheckIntervalMs, PROXY_CHECK_INTERVAL_MS);
    this.diskIntervalMs = Math.min(
      positive(deps.diskCheckIntervalMs, DISK_CHECK_INTERVAL_MS),
      MAX_DISK_CHECK_INTERVAL_MS,
    );
    this.networkIntervalMs = Math.min(
      positive(deps.networkCheckIntervalMs, NETWORK_CHECK_INTERVAL_MS),
      MAX_NETWORK_CHECK_INTERVAL_MS,
    );
    this.retryDelayMs = positive(deps.restartRetryDelayMs, DEFAULT_RESTART_RETRY_DELAY_MS);
  }

  /** Gate for the Jobs_API: call before creating a Job. Running Jobs are unaffected (13.7). */
  canCreateJob(): JobCreationGate {
    if (!this.disk.low) return { allowed: true };
    return {
      allowed: false,
      reason: "low-disk",
      freeBytes: this.disk.freeBytes,
      thresholdBytes: this.deps.diskThresholdBytes,
      message: `Free disk space (${this.disk.freeBytes} bytes) is below the ${this.deps.diskThresholdBytes} byte threshold; new Jobs are blocked.`,
    };
  }

  /** True once 3 consecutive restarts failed and the monitor stopped retrying. */
  isProxyDown(): boolean {
    return this.proxyGaveUp;
  }

  isNetworkPaused(): boolean {
    return this.networkPaused;
  }

  /** Runs the first check of each probe now, then keeps polling until `stop()`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop(this.proxyIntervalMs, () => this.checkProxy());
    this.loop(this.diskIntervalMs, () => this.checkDisk());
    this.loop(this.networkIntervalMs, () => this.checkNetwork());
  }

  stop(): void {
    this.running = false;
    for (const h of this.timers) this.clock.clearTimeout(h);
    this.timers.clear();
    if (this.networkPauseTimer !== null) {
      this.clock.clearTimeout(this.networkPauseTimer);
      this.networkPauseTimer = null;
    }
  }

  // ---- polling plumbing -------------------------------------------------------------------------

  /** Self-rescheduling loop: the next run starts `ms` after the previous one finished (no overlap). */
  private loop(ms: number, run: () => Promise<void>): void {
    const tick = async () => {
      if (!this.running) return;
      try {
        await run();
      } catch (err) {
        this.record("health.check-error", { error: errMsg(err) });
      }
      if (!this.running) return;
      this.schedule(ms, tick);
    };
    void tick();
  }

  private schedule(ms: number, fn: () => void): void {
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
  }

  /** Waits `ms` on the injected clock. Never resolves after `stop()`, which ends the awaiting loop. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(ms, resolve));
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.clock.setTimeout(
        () => reject(new Error(`${what} timed out after ${ms}ms`)),
        ms,
      );
      p.then(
        (v) => {
          this.clock.clearTimeout(handle);
          resolve(v);
        },
        (e: unknown) => {
          this.clock.clearTimeout(handle);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private emitProxy(kind: ProxyHealthEvent["kind"]): void {
    try {
      this.deps.onProxyEvent?.({ kind, atMs: this.clock.now() });
    } catch {
      // An observer must not break the remedy.
    }
  }

  private record(type: string, payload: Record<string, unknown>): void {
    const e: NewEvent = {
      jobId: HEALTH_EVENT_JOB_ID,
      type,
      payload,
      createdAtMs: this.clock.now(),
    };
    try {
      appendEvent(this.deps.db, e);
    } catch {
      // A failed health-log write must not stop the remedy that triggered it.
    }
  }

  private async notify(n: HealthNotification): Promise<void> {
    try {
      await this.deps.notify(n);
    } catch (err) {
      this.record("health.notify-failed", { kind: n.kind, error: errMsg(err) });
    }
  }

  // ---- Proxy (13.5, 13.6) -----------------------------------------------------------------------

  /** Returns undefined when healthy, otherwise why the check was missed. */
  private async proxyMissReason(): Promise<string | undefined> {
    try {
      const ok = await this.withTimeout(
        this.deps.probeProxy(),
        PROXY_PROBE_TIMEOUT_MS,
        "proxy health check",
      );
      return ok ? undefined : "proxy health check reported unhealthy";
    } catch (err) {
      return errMsg(err);
    }
  }

  async checkProxy(): Promise<void> {
    const reason = await this.proxyMissReason();
    if (reason === undefined) {
      if (this.proxyGaveUp) {
        this.record("health.proxy.recovered", {});
        this.emitProxy("recovered");
      }
      this.proxyGaveUp = false;
      this.proxyDownNotified = false;
      return;
    }
    if (this.proxyGaveUp) return; // Stopped retrying; keep probing so recovery is noticed.
    await this.restartProxyWithRetries(reason);
  }

  private async restartProxyWithRetries(reason: string): Promise<void> {
    this.emitProxy("down");
    for (let attempt = 1; attempt <= PROXY_MAX_RESTART_FAILURES; attempt++) {
      if (!this.running && attempt > 1) return;
      const failure = await this.restartOnce();
      if (failure === undefined) {
        this.record("health.proxy.restarted", {
          restartedAtMs: this.clock.now(),
          reason,
          attempt,
        });
        this.emitProxy("restarted");
        return;
      }
      this.record("health.proxy.restart-failed", {
        attemptedAtMs: this.clock.now(),
        reason,
        attempt,
        error: failure,
      });
      if (attempt < PROXY_MAX_RESTART_FAILURES) await this.sleep(this.retryDelayMs);
    }
    this.proxyGaveUp = true;
    this.record("health.proxy.gave-up", {
      atMs: this.clock.now(),
      failedRestarts: PROXY_MAX_RESTART_FAILURES,
    });
    this.emitProxy("gave-up");
    if (!this.proxyDownNotified) {
      this.proxyDownNotified = true;
      await this.notify({
        kind: "proxy-down",
        text: `The Proxy is down. ${PROXY_MAX_RESTART_FAILURES} restarts failed in a row, so FRIDAY stopped retrying.`,
        atMs: this.clock.now(),
      });
    }
  }

  /** One restart attempt plus a follow-up probe. Returns undefined on success, else the error text. */
  private async restartOnce(): Promise<string | undefined> {
    try {
      await this.withTimeout(this.deps.restartProxy(), PROXY_RESTART_TIMEOUT_MS, "proxy restart");
    } catch (err) {
      return errMsg(err);
    }
    const stillBad = await this.proxyMissReason();
    return stillBad === undefined ? undefined : `proxy unhealthy after restart: ${stillBad}`;
  }

  // ---- Disk (13.7) ------------------------------------------------------------------------------

  async checkDisk(): Promise<void> {
    let free: number;
    try {
      free = await this.deps.freeDiskBytes();
    } catch (err) {
      this.record("health.disk.probe-failed", { error: errMsg(err) });
      return; // Keep the previous gate state rather than guess.
    }
    const threshold = this.deps.diskThresholdBytes;
    const low = free < threshold;
    const wasLow = this.disk.low;
    this.disk = { low, freeBytes: free };
    if (low && !wasLow) {
      this.record("health.disk.low", { atMs: this.clock.now(), freeBytes: free, threshold });
      await this.notify({
        kind: "disk-low",
        text: `Free disk space is low (${free} bytes, threshold ${threshold}). New Jobs are blocked until space is freed; running Jobs continue.`,
        atMs: this.clock.now(),
      });
    } else if (!low && wasLow) {
      this.record("health.disk.recovered", { atMs: this.clock.now(), freeBytes: free, threshold });
    }
  }

  // ---- Network (13.8) ---------------------------------------------------------------------------

  async checkNetwork(): Promise<void> {
    let reachable: boolean;
    try {
      reachable = await this.withTimeout(
        this.deps.probeNetwork(),
        NETWORK_PROBE_TIMEOUT_MS,
        "network check",
      );
    } catch {
      reachable = false;
    }
    const now = this.clock.now();

    if (reachable) {
      this.clearPauseTimer();
      if (this.networkLostSinceMs !== null) {
        this.record("health.network.restored", {
          atMs: now,
          lostSinceMs: this.networkLostSinceMs,
        });
        this.networkLostSinceMs = null;
      }
      if (this.networkPaused) await this.resumeSteps();
      return;
    }

    if (this.networkLostSinceMs === null) {
      this.networkLostSinceMs = now;
      this.record("health.network.lost", { atMs: now });
      // Fire exactly at the 10s mark instead of waiting for the next poll.
      this.networkPauseTimer = this.clock.setTimeout(() => {
        this.networkPauseTimer = null;
        void this.pauseIfStillLost();
      }, NETWORK_LOSS_PAUSE_AFTER_MS);
    } else if (
      !this.networkPaused &&
      now - this.networkLostSinceMs >= NETWORK_LOSS_PAUSE_AFTER_MS
    ) {
      await this.pauseIfStillLost(); // Fallback when the pause timer's hook failed earlier.
    }
  }

  private clearPauseTimer(): void {
    if (this.networkPauseTimer === null) return;
    this.clock.clearTimeout(this.networkPauseTimer);
    this.networkPauseTimer = null;
  }

  private async pauseIfStillLost(): Promise<void> {
    if (this.networkLostSinceMs === null || this.networkPaused) return;
    try {
      await this.deps.pauseNetworkSteps();
    } catch (err) {
      this.record("health.network.pause-failed", { error: errMsg(err) });
      return; // networkPaused stays false, so the next poll retries.
    }
    this.networkPaused = true;
    this.record("health.network.steps-paused", {
      atMs: this.clock.now(),
      lostSinceMs: this.networkLostSinceMs,
    });
  }

  private async resumeSteps(): Promise<void> {
    try {
      await this.deps.resumeNetworkSteps();
    } catch (err) {
      this.record("health.network.resume-failed", { error: errMsg(err) });
      return; // Stays paused, so the next poll retries.
    }
    this.networkPaused = false;
    this.record("health.network.steps-resumed", { atMs: this.clock.now() });
  }
}

function positive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Real adapters -------------------------------------------------------------------------------

/** Free bytes available to unprivileged users on the volume holding `dir`. */
export function createDiskFreeProbe(dir: string): () => Promise<number> {
  return async () => {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  };
}

/** Healthy when `GET url` answers with a 2xx status. The monitor applies its own 10s deadline. */
export function createHttpProxyProbe(url: string): () => Promise<boolean> {
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROXY_PROBE_TIMEOUT_MS) });
    return res.ok;
  };
}

/** Reachable when a TCP connection opens. Defaults to a public DNS resolver on port 53. */
export function createTcpNetworkProbe(
  target: { host: string; port: number } = { host: "1.1.1.1", port: 53 },
  timeoutMs = NETWORK_PROBE_TIMEOUT_MS,
): () => Promise<boolean> {
  return () =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: target.host, port: target.port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
}
