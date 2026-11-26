// Multi-day operation integration tests (Requirements 13.1-13.8, 13.10, 13.11).
// These compose the ops modules (Scheduler, Notifier with Digest and Quiet_Hours, Health_Monitor,
// resume, ProxyRestartCoordinator) with the Orchestrator and the Jobs_API over a shared Event_Log.
// Unit-level behavior of each module is in its own *.test.ts; this file covers the combinations.
// Everything external is fake: vitest fake timers or the runner FakeClock for time, probes for disk
// and network, and a controllable Proxy. Nothing touches the real disk, network or a model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESUME_WINDOW_MS, resetJobEngineRestoreForTests } from "../engine/boot.js";
import { createJobsApiDeps, createJob as apiCreateJob } from "../../gateway/rpc/jobs.js";
import { MAX_STEP_ATTEMPTS, ProxyUnreachableError } from "../runner/step-runner.js";
import { flushMicrotasks } from "../runner/test-helpers.js";
import {
  appendEvent,
  EVENT_TYPES,
  loadEvents,
  openEventLog,
  projectJobState,
} from "../store/index.js";
import { HEALTH_EVENT_JOB_ID, HealthMonitor, type HealthNotification } from "./health.js";
import {
  type ChannelSender,
  type NotificationMessage,
  Notifier,
  type NotifierOptions,
} from "./notifier.js";
import { ProxyRestartCoordinator } from "./proxy-restart.js";
import { resumeAfterBoot } from "./resume.js";
import { createScheduler, type OpsSchedule, type SchedulerTimer } from "./scheduler.js";
import { createRig, healthClockFrom, never, rawTask } from "./test-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const daily: OpsSchedule = {
  id: "daily",
  kind: "daily-report",
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
};

function fakeSender(channel: string) {
  const sent: NotificationMessage[] = [];
  const sender: ChannelSender = {
    channel,
    async send(message) {
      sent.push(message);
    },
  };
  return { sender, sent };
}

function notifierRig(options: Partial<NotifierOptions> = {}) {
  const hud = fakeSender("hud");
  const wa = fakeSender("whatsapp");
  const n = new Notifier({ channels: [hud.sender, wa.sender], ...options });
  return { n, hud, wa };
}

const night = (approvals: "allow" | "hold") => ({
  start: "22:00",
  end: "06:00",
  timezone: "UTC",
  approvals,
});

/** A timer that fires each schedule at 08:00 UTC every day, twice per time (a duplicate delivery). */
function dailyTimer(): SchedulerTimer {
  return {
    async start(s, onTick) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        const now = Date.now();
        let next = Math.floor(now / DAY) * DAY + 8 * HOUR;
        if (next <= now) next += DAY;
        handle = setTimeout(() => {
          for (let i = 0; i < 2; i++) {
            void Promise.resolve(onTick({ scheduleId: s.id, scheduledAtMs: next })).catch(() => {});
          }
          arm();
        }, next - now);
      };
      arm();
      return () => clearTimeout(handle);
    },
  };
}

describe("ops integration: global fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule creates exactly one Job per time over three days and each Digest lists it once (13.1, 13.2)", async () => {
    vi.setSystemTime(new Date("2025-03-10T07:00:00Z"));
    const db = openEventLog(":memory:");
    const { n, hud, wa } = notifierRig({ digest: { time: "08:30", timezone: "UTC" } });
    n.start();
    let seq = 0;
    const scheduler = createScheduler({
      db,
      schedules: [daily],
      timer: dailyTimer(),
      createJob: async (input) => {
        const id = `ops-job-${++seq}`;
        appendEvent(db, { jobId: id, type: EVENT_TYPES.jobCreated, payload: { ...input } });
        n.recordJobChange({ jobId: id, status: "done", completedAtMs: Date.now() });
        return { id };
      },
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2 * DAY + 2 * HOUR); // to 2025-03-12T09:00Z
    const created = loadEvents(db).filter((e) => e.type === EVENT_TYPES.jobCreated);
    expect(created.map((e) => e.jobId)).toEqual(["ops-job-1", "ops-job-2", "ops-job-3"]);
    for (const ch of [hud, wa]) {
      const digests = ch.sent.filter((m) => m.kind === "digest");
      expect(digests).toHaveLength(3);
      expect(digests.map((d) => d.entries?.map((e) => e.jobId))).toEqual([
        ["ops-job-1"],
        ["ops-job-2"],
        ["ops-job-3"],
      ]);
    }
    // A Gateway restart replays yesterday's tick: no new Job.
    const restarted = createScheduler({
      db,
      schedules: [daily],
      timer: dailyTimer(),
      createJob: async () => {
        throw new Error("must not create a duplicate");
      },
    });
    const replay = await restarted.handleTick({
      scheduleId: "daily",
      scheduledAtMs: Date.parse("2025-03-11T08:00:00Z"),
    });
    expect(replay).toMatchObject({ status: "duplicate", jobId: "ops-job-2" });
    await scheduler.stop();
    n.dispose();
  });

  it("holds health notifications in Quiet_Hours and delivers them in order within 60s of the end (13.3, 13.5-13.7)", async () => {
    vi.setSystemTime(new Date("2025-03-10T22:00:00Z"));
    const db = openEventLog(":memory:");
    const { n, hud, wa } = notifierRig({ quietHours: night("hold") });
    let restarts = 0;
    const monitor = new HealthMonitor({
      db,
      probeProxy: async () => false,
      restartProxy: async () => {
        restarts++;
        throw new Error("spawn failed");
      },
      freeDiskBytes: async () => 10,
      probeNetwork: async () => true,
      notify: (note: HealthNotification) => void n.notify(note.text),
      pauseNetworkSteps: () => undefined,
      resumeNetworkSteps: () => undefined,
      diskThresholdBytes: 500,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(MIN);
    monitor.stop();
    expect(restarts).toBe(3); // stops retrying after 3 consecutive failures
    expect(n.heldCount()).toBe(2); // one proxy-down, one disk-low
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8 * HOUR - MIN - 1); // 05:59:59.999
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MIN + 1); // within 60s after 06:00
    for (const ch of [hud, wa]) {
      expect(ch.sent).toHaveLength(2);
      expect(ch.sent.map((m) => m.text)).toEqual(
        expect.arrayContaining([expect.stringMatching(/proxy/i), expect.stringMatching(/disk/i)]),
      );
    }
    n.dispose();
  });

  it.each([
    ["allow", true],
    ["hold", false],
  ] as const)(
    'approval requests during Quiet_Hours with setting "%s" while other notices are held (13.3, 13.4)',
    async (setting, deliveredAtOnce) => {
      vi.setSystemTime(new Date("2025-03-10T23:00:00Z"));
      const { n, hud } = notifierRig({ quietHours: night(setting) });
      n.notify("routine notice");
      void n.requestApproval({ jobId: "job-1", taskId: "t1", action: "deploy" });
      await vi.advanceTimersByTimeAsync(0);
      expect(hud.sent.map((m) => m.kind === "approval-request")).toEqual(
        deliveredAtOnce ? [true] : [],
      );
      expect(hud.sent.some((m) => m.text === "routine notice")).toBe(false); // notices always held
      await vi.advanceTimersByTimeAsync(7 * HOUR + MIN); // past 06:00 plus 60s
      expect(hud.sent.filter((m) => m.text === "routine notice")).toHaveLength(1);
      expect(hud.sent.filter((m) => m.kind === "approval-request")).toHaveLength(1);
      n.dispose();
    },
  );

  it("low disk blocks new Jobs, including scheduled ones, while a running Job continues (13.1, 13.7)", async () => {
    vi.setSystemTime(new Date("2025-03-10T07:59:00Z"));
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const process = rig.boot();
    process.agents.turn = () => never(); // the existing Job stays running
    const running = await process.orchestrator.createJob({
      goal: "long job",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50 && process.agents.turns.length === 0; i++) await flushMicrotasks();

    const disk = { free: 10 };
    const notes: HealthNotification[] = [];
    const monitor = new HealthMonitor({
      db: rig.db,
      probeProxy: async () => true,
      restartProxy: async () => undefined,
      freeDiskBytes: async () => disk.free,
      probeNetwork: async () => true,
      notify: (note) => void notes.push(note),
      pauseNetworkSteps: () => undefined,
      resumeNetworkSteps: () => undefined,
      diskThresholdBytes: 500,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.canCreateJob()).toMatchObject({ allowed: false, reason: "low-disk" });
    expect(notes.filter((x) => x.kind === "disk-low")).toHaveLength(1);

    // Jobs_API refuses and writes nothing.
    const api = createJobsApiDeps({
      db: rig.db,
      orchestrator: process.orchestrator,
      canCreateJob: () => monitor.canCreateJob(),
    });
    const before = loadEvents(rig.db).length;
    const refused = await apiCreateJob(api, { goal: "new work" });
    expect(refused).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(loadEvents(rig.db)).toHaveLength(before);

    // The 08:00 scheduled Job is refused the same way, and is not recorded.
    const gatedCreate = async (input: {
      goal: string;
      type: "operations" | "coding" | "research";
    }) => {
      const gate = monitor.canCreateJob();
      if (!gate.allowed) throw new Error(gate.message);
      return process.orchestrator.createJob({
        ...input,
        initialPlan: { tasks: [rawTask("op")] },
      });
    };
    const scheduler = createScheduler({
      db: rig.db,
      schedules: [daily],
      timer: dailyTimer(),
      createJob: gatedCreate,
    });
    const tick = { scheduleId: "daily", scheduledAtMs: Date.parse("2025-03-10T08:00:00Z") };
    vi.setSystemTime(new Date("2025-03-10T08:00:01Z"));
    expect(await scheduler.handleTick(tick)).toMatchObject({ status: "failed" });

    // The running Job was not touched.
    const state = projectJobState(loadEvents(rig.db)).jobs[running.id]?.state;
    expect(state).toBe("running");

    // Free space returns: new Jobs are allowed again, and the same tick creates exactly one Job.
    disk.free = 500;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.canCreateJob()).toEqual({ allowed: true });
    const retried = await scheduler.handleTick(tick);
    expect(retried.status).toBe("created");
    expect(await scheduler.handleTick(tick)).toMatchObject({ status: "duplicate" });
    monitor.stop();
  });
});

describe("ops integration: runner fake clock", () => {
  it("network loss pauses Steps after 10s and they resume within 30s of recovery (13.8)", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const net = { online: false };
    let paused = false;
    let releaseSteps: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    const marks = { pausedAt: 0, resumedAt: 0, recoveredAt: 0 };
    const monitor = new HealthMonitor({
      db: rig.db,
      clock: healthClockFrom(rig.clock),
      probeProxy: async () => true,
      restartProxy: async () => undefined,
      freeDiskBytes: async () => 1_000,
      probeNetwork: async () => net.online,
      notify: () => undefined,
      pauseNetworkSteps: () => {
        paused = true;
        marks.pausedAt = rig.clock.now();
        gate = new Promise<void>((resolve) => (releaseSteps = resolve));
      },
      resumeNetworkSteps: () => {
        paused = false;
        marks.resumedAt = rig.clock.now();
        releaseSteps();
      },
      diskThresholdBytes: 1,
    });
    const process = rig.boot();
    // A network Step waits at its start while the monitor has paused network Steps.
    process.agents.turn = async (req) => {
      await gate;
      return { reply: `ok ${req.stepId}` };
    };
    const startedAt = rig.clock.now();
    monitor.start();
    await flushMicrotasks(); // first check runs at start and sees the loss
    await rig.clock.advance(11_000); // paused 10s after the loss
    expect(paused).toBe(true);
    expect(marks.pausedAt - startedAt).toBe(10_000);

    const { id } = await process.orchestrator.createJob({
      goal: "net job",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await rig.clock.advance(5_000);
    expect(rig.ofType(id, "step-completed")).toHaveLength(0); // held while paused

    net.online = true;
    marks.recoveredAt = rig.clock.now();
    await rig.clock.advance(30_000);
    monitor.stop();
    expect(paused).toBe(false);
    expect(marks.resumedAt - marks.recoveredAt).toBeLessThanOrEqual(30_000);
    const view = await rig.clock.drive(process.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
  });

  it("after a reboot, Jobs resume within 60s of Gateway start and the schedule adds no duplicate (13.1, 13.10)", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot();
    a.agents.turn = () => never(); // Gateway dies with the Step in flight
    const scheduledAtMs = rig.clock.now();
    const createOps =
      (p: ReturnType<typeof rig.boot>) =>
      async (input: { goal: string; type: "operations" | "coding" | "research" }) =>
        p.orchestrator.createJob({ ...input, initialPlan: { tasks: [rawTask("a")] } });
    const noTimer: SchedulerTimer = { start: async () => () => undefined };
    const first = createScheduler({
      db: rig.db,
      schedules: [daily],
      timer: noTimer,
      createJob: createOps(a),
      clock: rig.clock,
    });
    const created = await first.handleTick({ scheduleId: "daily", scheduledAtMs });
    if (created.status !== "created") throw new Error("expected a created Job");
    for (let i = 0; i < 200 && a.agents.turns.length === 0; i++) await flushMicrotasks();
    appendEvent(rig.db, { jobId: HEALTH_EVENT_JOB_ID, type: "health.note", payload: {} });

    rig.clock.jump(45_000); // machine is down for 45s
    const b = rig.boot();
    const bootTimeMs = rig.clock.now();
    const notify = vi.fn();
    const res = await rig.clock.drive(
      resumeAfterBoot({
        db: rig.db,
        orchestrator: b.orchestrator,
        clock: rig.clock,
        bootTimeMs,
        notifier: { notify },
      }),
    );
    expect(res.adopted.map((x) => x.jobId)).toEqual([created.jobId]);
    expect(res.withinDeadline).toBe(true);
    expect(res.startedAtMs - bootTimeMs).toBeLessThanOrEqual(RESUME_WINDOW_MS);
    expect(res.failed).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    // The restarted Scheduler sees the same tick again and creates nothing.
    const second = createScheduler({
      db: rig.db,
      schedules: [daily],
      timer: noTimer,
      createJob: createOps(b),
      clock: rig.clock,
    });
    expect(await second.handleTick({ scheduleId: "daily", scheduledAtMs })).toMatchObject({
      status: "duplicate",
      jobId: created.jobId,
    });
    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(created.jobId));
    expect(view.state).toBe("done");
    expect(rig.ofType(created.jobId, EVENT_TYPES.jobCreated)).toHaveLength(1);
  });

  it("three failed Proxy restarts stop the retries, notify once and fail the interrupted Job with a notice (13.5, 13.6, 13.11)", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const jobNotify = vi.fn();
    const healthNotes: HealthNotification[] = [];
    let restarts = 0;
    const probeProxy = async () => false;
    const coordinator = new ProxyRestartCoordinator({
      db: rig.db,
      probeProxy,
      notifier: { notify: jobNotify },
      clock: healthClockFrom(rig.clock),
    });
    const monitor = new HealthMonitor({
      db: rig.db,
      clock: healthClockFrom(rig.clock),
      probeProxy,
      restartProxy: async () => {
        restarts++;
        throw new Error("proxy would not start");
      },
      freeDiskBytes: async () => 1_000,
      probeNetwork: async () => true,
      notify: (note) => void healthNotes.push(note),
      onProxyEvent: coordinator.handleHealthEvent,
      pauseNetworkSteps: () => undefined,
      resumeNetworkSteps: () => undefined,
      diskThresholdBytes: 1,
    });
    const process = rig.boot({ proxyRecovery: coordinator });
    let turns = 0;
    process.agents.turn = async () => {
      turns++;
      throw new ProxyUnreachableError();
    };
    monitor.start();
    const { id } = await process.orchestrator.createJob({
      goal: "needs proxy",
      initialPlan: { tasks: [rawTask("a")] },
    });
    const view = await rig.clock.drive(process.orchestrator.awaitTerminal(id));
    monitor.stop();
    expect(view.state).toBe("failed");
    expect(restarts).toBe(3);
    expect(healthNotes.filter((x) => x.kind === "proxy-down")).toHaveLength(1);
    expect(turns).toBe(MAX_STEP_ATTEMPTS); // no retry once the monitor gave up
    expect(jobNotify).toHaveBeenCalledTimes(1);
    expect(jobNotify.mock.calls[0]?.[0]).toContain(id);
    expect(rig.ofType(id, "proxy-retry-scheduled")).toHaveLength(0);
    expect(rig.ofType(id, "proxy-retry-failed")).toHaveLength(1);
  });

  it("a restarted Proxy gets one Step retry; when it fails the Job fails and the user is notified on every channel (13.5, 13.11)", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const { n, hud, wa } = notifierRig();
    const proxy = { up: false };
    const coordinator = new ProxyRestartCoordinator({
      db: rig.db,
      probeProxy: async () => proxy.up,
      notifier: n,
      clock: healthClockFrom(rig.clock),
    });
    const monitor = new HealthMonitor({
      db: rig.db,
      clock: healthClockFrom(rig.clock),
      probeProxy: async () => proxy.up,
      restartProxy: async () => {
        proxy.up = true; // the restart works, the Step's own turn still fails
      },
      freeDiskBytes: async () => 1_000,
      probeNetwork: async () => true,
      notify: () => undefined,
      onProxyEvent: coordinator.handleHealthEvent,
      pauseNetworkSteps: () => undefined,
      resumeNetworkSteps: () => undefined,
      diskThresholdBytes: 1,
    });
    const process = rig.boot({ proxyRecovery: coordinator });
    let turns = 0;
    process.agents.turn = async () => {
      turns++;
      throw new ProxyUnreachableError();
    };
    monitor.start();
    const { id } = await process.orchestrator.createJob({
      goal: "needs proxy",
      initialPlan: { tasks: [rawTask("a")] },
    });
    const view = await rig.clock.drive(process.orchestrator.awaitTerminal(id));
    monitor.stop();
    expect(view.state).toBe("failed");
    expect(turns).toBe(MAX_STEP_ATTEMPTS + 1); // exactly one retry
    expect(rig.ofType(id, "proxy-retry-scheduled")).toHaveLength(1);
    await vi.waitFor(() => {
      expect(hud.sent).toHaveLength(1);
      expect(wa.sent).toHaveLength(1);
    });
    expect(hud.sent[0]?.text).toContain(id);
    n.dispose();
  });
});
