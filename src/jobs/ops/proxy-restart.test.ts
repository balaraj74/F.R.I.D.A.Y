// ProxyRestartCoordinator (Requirement 13.11): a Step interrupted by a Proxy restart is retried once
// after the Proxy responds; if that fails the Job fails and the user is told. Fake clock and Proxy.
import { describe, expect, it, vi } from "vitest";

import type { ProxyRetryRequest } from "../orchestrator/runtime-types.js";
import { MAX_STEP_ATTEMPTS, ProxyUnreachableError } from "../runner/step-runner.js";
import { FakeClock } from "../runner/test-helpers.js";
import { loadEvents, openEventLog } from "../store/index.js";
import { HEALTH_EVENT_JOB_ID } from "./health.js";
import { PROXY_RETRY_WINDOW_MS, ProxyRestartCoordinator } from "./proxy-restart.js";
import { createRig, healthClockFrom, rawTask } from "./test-helpers.js";

const req = (over: Partial<ProxyRetryRequest> = {}): ProxyRetryRequest => ({
  jobId: "j1",
  taskId: "t1",
  stepId: "t1.1.1",
  reason: "Proxy unreachable after 5 attempts",
  signal: new AbortController().signal,
  ...over,
});

function coordinatorRig(over: { pollIntervalMs?: number; maxWaitMs?: number } = {}) {
  const clock = new FakeClock();
  const db = openEventLog(":memory:");
  const proxy = { up: false };
  const notify = vi.fn();
  const coordinator = new ProxyRestartCoordinator({
    db,
    probeProxy: async () => proxy.up,
    notifier: { notify },
    clock: healthClockFrom(clock),
    ...over,
  });
  const healthEvents = (type: string) =>
    loadEvents(db, HEALTH_EVENT_JOB_ID).filter((e) => e.type === type);
  return { clock, db, proxy, notify, coordinator, healthEvents };
}

describe("ProxyRestartCoordinator.awaitRetry", () => {
  it("waits for the Proxy to respond, then allows the retry and records when", async () => {
    const t = coordinatorRig();
    const startedAt = t.clock.now();
    t.clock.setTimer(() => (t.proxy.up = true), 7_500);

    const decision = await t.clock.drive(t.coordinator.awaitRetry(req()));

    expect(decision.retry).toBe(true);
    if (!decision.retry) return;
    expect(decision.respondedAtMs - startedAt).toBeGreaterThanOrEqual(7_500);
    expect(decision.respondedAtMs - startedAt).toBeLessThan(7_500 + 1_000 + 1);
    const [ready] = t.healthEvents("health.proxy.step-retry-ready");
    expect(ready?.payload).toMatchObject({
      jobId: "j1",
      stepId: "t1.1.1",
      retryByMs: decision.respondedAtMs + PROXY_RETRY_WINDOW_MS,
    });
  });

  it("answers at once when the Proxy already responds", async () => {
    const t = coordinatorRig();
    t.proxy.up = true;
    const decision = await t.clock.drive(t.coordinator.awaitRetry(req()));
    expect(decision).toEqual({ retry: true, respondedAtMs: t.clock.now() });
  });

  it("wakes on a Health_Monitor 'restarted' event without waiting for the next poll", async () => {
    const t = coordinatorRig({ pollIntervalMs: 10_000 });
    const pending = t.coordinator.awaitRetry(req());
    await t.clock.advance(2_000);
    t.proxy.up = true;
    t.coordinator.handleHealthEvent({ kind: "restarted", atMs: t.clock.now() });
    const decision = await t.clock.drive(pending);
    expect(decision.retry).toBe(true);
    if (decision.retry) expect(decision.respondedAtMs - 1_000_000).toBe(2_000);
  });

  it("gives up when the Health_Monitor reports it stopped retrying", async () => {
    const t = coordinatorRig();
    const pending = t.coordinator.awaitRetry(req());
    await t.clock.advance(3_000);
    t.coordinator.handleHealthEvent({ kind: "gave-up", atMs: t.clock.now() });
    const decision = await t.clock.drive(pending);
    expect(decision).toMatchObject({ retry: false });
    expect(decision.retry === false && decision.reason).toContain("Proxy is down");
  });

  it("gives up when the Proxy does not respond within the wait limit", async () => {
    const t = coordinatorRig({ maxWaitMs: 20_000 });
    const decision = await t.clock.drive(t.coordinator.awaitRetry(req()));
    expect(decision).toEqual({ retry: false, reason: "the Proxy did not respond within 20s" });
    expect(t.clock.now() - 1_000_000).toBeGreaterThanOrEqual(20_000);
  });

  it("stops waiting when the Job is cancelled", async () => {
    const t = coordinatorRig();
    const ctl = new AbortController();
    const pending = t.coordinator.awaitRetry(req({ signal: ctl.signal }));
    await t.clock.advance(2_000);
    ctl.abort();
    expect(await t.clock.drive(pending)).toEqual({ retry: false, reason: "stopped" });
  });

  it("allows only one retry per Step", async () => {
    const t = coordinatorRig();
    t.proxy.up = true;
    expect((await t.clock.drive(t.coordinator.awaitRetry(req()))).retry).toBe(true);
    const second = await t.clock.drive(t.coordinator.awaitRetry(req()));
    expect(second).toMatchObject({ retry: false });
    // A different Step still gets its own retry.
    expect((await t.clock.drive(t.coordinator.awaitRetry(req({ stepId: "t1.1.2" })))).retry).toBe(
      true,
    );
  });
});

describe("ProxyRestartCoordinator.retryFailed", () => {
  it("notifies the user and logs the failure", async () => {
    const t = coordinatorRig();
    await t.coordinator.retryFailed(req({ reason: "the retry after the Proxy restart failed" }));
    expect(t.notify).toHaveBeenCalledTimes(1);
    const text = t.notify.mock.calls[0]?.[0] as string;
    expect(text).toContain("Job j1 failed");
    expect(text).toContain("t1.1.1");
    expect(t.healthEvents("health.proxy.step-retry-failed")).toHaveLength(1);
  });

  it("still logs when the notifier throws", async () => {
    const t = coordinatorRig();
    t.notify.mockRejectedValueOnce(new Error("channel down"));
    await expect(t.coordinator.retryFailed(req())).resolves.toBeUndefined();
    expect(t.healthEvents("health.proxy.step-retry-notify-failed")).toHaveLength(1);
  });
});

describe("Orchestrator with ProxyRestartCoordinator", () => {
  /** A Proxy whose probe and turns can be controlled separately, on the rig's fake clock. */
  function setup(opts: { proxyUpAfterMs: number | null; turnsWorkAfterRestart: boolean }) {
    const rig = createRig();
    const proxy = { probeUp: false, turnsWork: false };
    const notify = vi.fn();
    const coordinator = new ProxyRestartCoordinator({
      db: rig.db,
      probeProxy: async () => proxy.probeUp,
      notifier: { notify },
      clock: healthClockFrom(rig.clock),
      maxWaitMs: 60_000,
    });
    const process = rig.boot({ proxyRecovery: coordinator });
    const turnTimes: number[] = [];
    process.agents.turn = async (req) => {
      turnTimes.push(rig.clock.now());
      if (!proxy.turnsWork) throw new ProxyUnreachableError();
      return { reply: `done ${req.stepId}` };
    };
    if (opts.proxyUpAfterMs !== null) {
      rig.clock.setTimer(() => {
        proxy.probeUp = true;
        proxy.turnsWork = opts.turnsWorkAfterRestart;
      }, opts.proxyUpAfterMs);
    }
    return { rig, process, notify, turnTimes };
  }

  it("retries the interrupted Step once within 30s of the Proxy responding and continues the Job", async () => {
    const t = setup({ proxyUpAfterMs: 8_000, turnsWorkAfterRestart: true });
    const { id } = await t.process.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    const view = await t.rig.clock.drive(t.process.orchestrator.awaitTerminal(id));

    expect(view.state).toBe("done");
    expect(t.notify).not.toHaveBeenCalled();
    // MAX_STEP_ATTEMPTS attempts before the Proxy restart, then exactly one more.
    expect(t.turnTimes).toHaveLength(MAX_STEP_ATTEMPTS + 1);
    const [scheduled] = t.rig.ofType(id, "proxy-retry-scheduled");
    const payload = scheduled?.payload as { respondedAtMs: number };
    const { respondedAtMs } = payload;
    const retryStartedAt = t.turnTimes.at(-1) as number;
    expect(retryStartedAt).toBeGreaterThanOrEqual(respondedAtMs);
    expect(retryStartedAt - respondedAtMs).toBeLessThanOrEqual(PROXY_RETRY_WINDOW_MS);
  });

  it("fails the Job and notifies the user when the retry fails", async () => {
    const t = setup({ proxyUpAfterMs: 8_000, turnsWorkAfterRestart: false });
    const { id } = await t.process.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    const view = await t.rig.clock.drive(t.process.orchestrator.awaitTerminal(id));

    expect(view.state).toBe("failed");
    expect(view.tasks[0]?.stateReason).toContain("retry after Proxy restart failed");
    expect(t.turnTimes).toHaveLength(MAX_STEP_ATTEMPTS + 1); // retried once, not again
    expect(t.rig.ofType(id, "proxy-retry-scheduled")).toHaveLength(1);
    expect(t.rig.ofType(id, "proxy-retry-failed")).toHaveLength(1);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0]?.[0]).toContain(id);
  });

  it("fails the Job and notifies the user when the Proxy never responds", async () => {
    const t = setup({ proxyUpAfterMs: null, turnsWorkAfterRestart: false });
    const { id } = await t.process.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    const view = await t.rig.clock.drive(t.process.orchestrator.awaitTerminal(id));

    expect(view.state).toBe("failed");
    expect(t.turnTimes).toHaveLength(MAX_STEP_ATTEMPTS); // no retry without a response
    expect(t.rig.ofType(id, "proxy-retry-scheduled")).toHaveLength(0);
    expect(t.rig.ofType(id, "proxy-retry-failed")).toHaveLength(1);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it("does not retry other kinds of Step failure", async () => {
    const t = setup({ proxyUpAfterMs: 1_000, turnsWorkAfterRestart: true });
    t.process.agents.turn = async () => {
      throw new Error("model exploded");
    };
    const { id } = await t.rig.clock.drive(
      t.process.orchestrator.createJob({ goal: "g", initialPlan: { tasks: [rawTask("a")] } }),
    );
    const view = await t.rig.clock.drive(t.process.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("failed");
    expect(t.rig.ofType(id, "proxy-retry-scheduled")).toHaveLength(0);
    expect(t.notify).not.toHaveBeenCalled();
  });
});
