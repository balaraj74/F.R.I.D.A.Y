import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEvents, openEventLog } from "../store/log.js";
import {
  HEALTH_EVENT_JOB_ID,
  type HealthMonitorDeps,
  HealthMonitor,
  type HealthNotification,
} from "./health.js";

/** Mutable fakes behind the injected externals. Time comes from vitest fake timers. */
function setup(over: Partial<HealthMonitorDeps> = {}) {
  const db: DatabaseSync = openEventLog(":memory:");
  const state = { proxyHealthy: true, restartOk: true, freeBytes: 1000, online: true };
  const notes: HealthNotification[] = [];
  const calls = { restart: 0, pause: 0, resume: 0 };
  const deps: HealthMonitorDeps = {
    db,
    probeProxy: async () => state.proxyHealthy,
    restartProxy: async () => {
      calls.restart++;
      if (!state.restartOk) throw new Error("spawn failed");
      state.proxyHealthy = true;
    },
    freeDiskBytes: async () => state.freeBytes,
    probeNetwork: async () => state.online,
    notify: (n) => {
      notes.push(n);
    },
    pauseNetworkSteps: () => {
      calls.pause++;
    },
    resumeNetworkSteps: () => {
      calls.resume++;
    },
    diskThresholdBytes: 500,
    ...over,
  };
  const monitor = new HealthMonitor(deps);
  const types = () => loadEvents(db, HEALTH_EVENT_JOB_ID).map((e) => e.type);
  const events = (type: string) =>
    loadEvents(db, HEALTH_EVENT_JOB_ID).filter((e) => e.type === type);
  return { monitor, state, notes, calls, types, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Health_Monitor proxy (13.5, 13.6)", () => {
  it("restarts within 30s of a missed check and logs the restart time and reason", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.restart).toBe(0);

    t.state.proxyHealthy = false;
    await vi.advanceTimersByTimeAsync(10_000); // next 10s check misses
    expect(t.calls.restart).toBe(1);

    const [restarted] = t.events("health.proxy.restarted");
    const payload = restarted?.payload as { reason: string; restartedAtMs: number };
    expect(payload.reason).toMatch(/unhealthy/);
    expect(payload.restartedAtMs).toBe(restarted?.createdAtMs);
    t.monitor.stop();
  });

  it("treats a probe that hangs past 10s as a missed check", async () => {
    const t = setup({ probeProxy: () => new Promise<boolean>(() => {}) });
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(t.calls.restart).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls.restart).toBe(1);
    t.monitor.stop();
  });

  it("stops after 3 consecutive failed restarts, notifies once and logs each failure", async () => {
    const t = setup({ restartRetryDelayMs: 1_000 });
    t.state.proxyHealthy = false;
    t.state.restartOk = false;
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(t.calls.restart).toBe(3);
    expect(t.events("health.proxy.restart-failed")).toHaveLength(3);
    expect(t.events("health.proxy.gave-up")).toHaveLength(1);
    expect(t.notes.filter((n) => n.kind === "proxy-down")).toHaveLength(1);
    expect(t.monitor.isProxyDown()).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000); // later polls do not restart again
    expect(t.calls.restart).toBe(3);
    expect(t.notes).toHaveLength(1);
    t.monitor.stop();
  });

  it("counts a restart that leaves the Proxy unhealthy as a failure", async () => {
    const restart = vi.fn(async () => {}); // resolves but never heals the Proxy
    const t2 = setup({ restartProxy: restart, restartRetryDelayMs: 1_000 });
    t2.state.proxyHealthy = false;
    t2.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restart).toHaveBeenCalledTimes(3);
    expect(t2.monitor.isProxyDown()).toBe(true);
    t2.monitor.stop();
  });

  it("resets after recovery so a later outage restarts again", async () => {
    const t = setup({ restartRetryDelayMs: 1_000 });
    t.state.proxyHealthy = false;
    t.state.restartOk = false;
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.monitor.isProxyDown()).toBe(true);

    t.state.proxyHealthy = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.monitor.isProxyDown()).toBe(false);
    expect(t.events("health.proxy.recovered")).toHaveLength(1);
    t.monitor.stop();
  });
  it("reports down, restarted, gave-up and recovered to onProxyEvent, and survives a throwing observer", async () => {
    const kinds: string[] = [];
    const t = setup({
      restartRetryDelayMs: 1_000,
      onProxyEvent: (e) => {
        kinds.push(e.kind);
        throw new Error("observer bug");
      },
    });
    t.state.proxyHealthy = false;
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds).toEqual(["down", "restarted"]);

    t.state.restartOk = false;
    t.state.proxyHealthy = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(kinds.slice(2)).toEqual(["down", "gave-up"]);
    expect(t.monitor.isProxyDown()).toBe(true);

    t.state.proxyHealthy = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kinds.at(-1)).toBe("recovered");
    t.monitor.stop();
  });
});

describe("Health_Monitor disk (13.7)", () => {
  it("notifies and blocks new Jobs below the threshold, then unblocks at the threshold", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.monitor.canCreateJob()).toEqual({ allowed: true });

    t.state.freeBytes = 499;
    await vi.advanceTimersByTimeAsync(10_000);
    const gate = t.monitor.canCreateJob();
    expect(gate).toMatchObject({ allowed: false, reason: "low-disk", freeBytes: 499 });
    expect(t.notes.filter((n) => n.kind === "disk-low")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000); // no repeat notification while still low
    expect(t.notes).toHaveLength(1);

    t.state.freeBytes = 500; // exactly at the threshold is allowed
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.monitor.canCreateJob()).toEqual({ allowed: true });
    expect(t.events("health.disk.recovered")).toHaveLength(1);
    t.monitor.stop();
  });

  it("does not touch running Jobs: it only calls notify and never the pause hook", async () => {
    const t = setup();
    t.state.freeBytes = 0;
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.pause).toBe(0);
    expect(t.calls.resume).toBe(0);
    t.monitor.stop();
  });

  it("notifies within 60s of the disk falling below the threshold", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    t.state.freeBytes = 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.notes.some((n) => n.kind === "disk-low")).toBe(true);
    t.monitor.stop();
  });
});

describe("Health_Monitor network (13.8)", () => {
  it("pauses network Steps after 10s of lost connectivity, not before", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    t.state.online = false;
    await vi.advanceTimersByTimeAsync(2_000); // loss detected at the next poll
    const lostAt = (t.events("health.network.lost")[0] as { createdAtMs: number }).createdAtMs;

    await vi.advanceTimersByTimeAsync(9_000);
    expect(t.calls.pause).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.calls.pause).toBe(1);
    const pausedAt = (t.events("health.network.steps-paused")[0] as { createdAtMs: number })
      .createdAtMs;
    expect(pausedAt - lostAt).toBe(10_000);
    t.monitor.stop();
  });

  it("does not pause for an outage shorter than 10s", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    t.state.online = false;
    await vi.advanceTimersByTimeAsync(4_000);
    t.state.online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.calls.pause).toBe(0);
    expect(t.calls.resume).toBe(0);
    t.monitor.stop();
  });

  it("resumes within 30s of recovery", async () => {
    const t = setup();
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    t.state.online = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.monitor.isNetworkPaused()).toBe(true);

    t.state.online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.calls.resume).toBe(1);
    expect(t.monitor.isNetworkPaused()).toBe(false);
    t.monitor.stop();
  });

  it("retries a failed resume on the next poll and stays paused meanwhile", async () => {
    let fail = true;
    const t = setup({
      resumeNetworkSteps: () => {
        if (fail) throw new Error("engine busy");
      },
    });
    t.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    t.state.online = false;
    await vi.advanceTimersByTimeAsync(15_000);
    t.state.online = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.monitor.isNetworkPaused()).toBe(true);
    expect(t.events("health.network.resume-failed").length).toBeGreaterThan(0);

    fail = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.monitor.isNetworkPaused()).toBe(false);
    t.monitor.stop();
  });
});
