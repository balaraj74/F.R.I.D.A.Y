import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { appendEvent, openEventLog } from "../store/log.js";
import { EVENT_TYPES } from "../store/project.js";
import {
  createCronTimer,
  createScheduler,
  dedupeKey,
  resolveScheduledAtMs,
  type CronLike,
  type OpsSchedule,
  type SchedulerTimer,
  type TickHandler,
} from "./scheduler.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);

const daily: OpsSchedule = {
  id: "daily",
  kind: "daily-report",
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
};

/** Fake createJob that records a job-created event the way the Orchestrator does. */
function setup(schedules: OpsSchedule[] = [daily]) {
  const db = openEventLog(":memory:");
  let n = 0;
  const created: Array<{ goal: string; type: string }> = [];
  const createJob = async (input: { goal: string; type: "operations" | "coding" | "research" }) => {
    created.push(input);
    const id = `job-${++n}`;
    appendEvent(db, { jobId: id, type: EVENT_TYPES.jobCreated, payload: { ...input } });
    return { id };
  };
  const handlers = new Map<string, TickHandler>();
  const timer: SchedulerTimer = {
    async start(s, onTick) {
      handlers.set(s.id, onTick);
      return () => void handlers.delete(s.id);
    },
  };
  let now = T0 + 5_000;
  const scheduler = createScheduler({
    db,
    createJob,
    timer,
    schedules,
    clock: { now: () => now },
  });
  return { db, created, createJob, handlers, scheduler, setNow: (v: number) => (now = v) };
}

describe("Scheduler", () => {
  it("creates one operations Job for a tick", async () => {
    const { scheduler, created } = setup();
    const res = await scheduler.handleTick({ scheduleId: "daily", scheduledAtMs: T0 });
    expect(res).toMatchObject({ status: "created", key: dedupeKey("daily", T0), lateMs: 5_000 });
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("operations");
    expect(created[0]?.goal).toContain("daily report");
  });

  it("creates no second Job when the same tick fires twice", async () => {
    const { scheduler, created } = setup();
    const tick = { scheduleId: "daily", scheduledAtMs: T0 };
    const first = await scheduler.handleTick(tick);
    const second = await scheduler.handleTick(tick);
    expect(second).toMatchObject({ status: "duplicate" });
    expect(second.status === "duplicate" && first.status === "created" && second.jobId).toBe(
      first.status === "created" ? first.jobId : "",
    );
    expect(created).toHaveLength(1);
  });

  it("creates one Job for two concurrent ticks", async () => {
    const { scheduler, created } = setup();
    const tick = { scheduleId: "daily", scheduledAtMs: T0 };
    const [a, b] = await Promise.all([scheduler.handleTick(tick), scheduler.handleTick(tick)]);
    expect([a.status, b.status].sort()).toEqual(["created", "duplicate"]);
    expect(created).toHaveLength(1);
  });

  it("does not repeat a Job after a restart (new scheduler, same Event_Log)", async () => {
    const first = setup();
    await first.scheduler.handleTick({ scheduleId: "daily", scheduledAtMs: T0 });
    const restarted = createScheduler({
      db: first.db,
      createJob: first.createJob,
      timer: { start: async () => () => undefined },
      schedules: [daily],
    });
    const res = await restarted.handleTick({ scheduleId: "daily", scheduledAtMs: T0 });
    expect(res.status).toBe("duplicate");
    expect(first.created).toHaveLength(1);
  });

  it("creates a new Job for the next scheduled time", async () => {
    const { scheduler, created } = setup();
    await scheduler.handleTick({ scheduleId: "daily", scheduledAtMs: T0 });
    await scheduler.handleTick({ scheduleId: "daily", scheduledAtMs: T0 + 24 * HOUR });
    expect(created).toHaveLength(2);
  });

  it("keeps schedules independent and ignores unknown ones", async () => {
    const other: OpsSchedule = {
      ...daily,
      id: "monitor",
      kind: "monitoring",
      goal: "Check things",
    };
    const { scheduler, created } = setup([daily, other]);
    await scheduler.handleTick({ scheduleId: "daily", scheduledAtMs: T0 });
    await scheduler.handleTick({ scheduleId: "monitor", scheduledAtMs: T0 });
    expect(await scheduler.handleTick({ scheduleId: "nope", scheduledAtMs: T0 })).toEqual({
      status: "ignored",
      reason: "unknown-schedule",
    });
    expect(created).toHaveLength(2);
    expect(created[1]?.goal.startsWith("Check things")).toBe(true);
  });

  it("retries after createJob fails, without recording a Job", async () => {
    const h = setup();
    let fail = true;
    const scheduler = createScheduler({
      db: h.db,
      createJob: async (input) => {
        if (fail) throw new Error("boom");
        return h.createJob(input);
      },
      timer: { start: async () => () => undefined },
      schedules: [daily],
    });
    const tick = { scheduleId: "daily", scheduledAtMs: T0 };
    expect(await scheduler.handleTick(tick)).toMatchObject({ status: "failed", error: "boom" });
    fail = false;
    expect((await scheduler.handleTick(tick)).status).toBe("created");
  });

  it("starts and stops the timer for each schedule", async () => {
    const { scheduler, handlers, created } = setup();
    await scheduler.start();
    expect([...handlers.keys()]).toEqual(["daily"]);
    handlers.get("daily")?.({ scheduleId: "daily", scheduledAtMs: T0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toHaveLength(1);
    await scheduler.stop();
    expect(handlers.size).toBe(0);
  });

  it("rejects invalid schedule configuration", () => {
    const { db, createJob, timer } = { ...setup(), timer: { start: async () => () => undefined } };
    const mk = (schedules: OpsSchedule[]) => () =>
      createScheduler({ db, createJob, timer, schedules });
    expect(mk([daily, daily])).toThrow(/duplicate/);
    expect(mk([{ ...daily, id: "bad id" }])).toThrow(/invalid schedule id/);
    expect(mk([{ ...daily, kind: "other" as never }])).toThrow(/unknown kind/);
  });
});

describe("resolveScheduledAtMs", () => {
  it("maps a late cron fire to the scheduled time", () => {
    expect(resolveScheduledAtMs(daily.schedule, T0 + 20_000)).toBe(T0);
    expect(resolveScheduledAtMs(daily.schedule, T0 + 20_000)).toBe(
      resolveScheduledAtMs(daily.schedule, T0 + 40_000),
    );
  });

  it("returns undefined when no cron occurrence is within the lookback", () => {
    expect(resolveScheduledAtMs(daily.schedule, T0 + 2 * HOUR)).toBeUndefined();
  });

  it("property: every-schedule slots are aligned, not after the fire time, and within one period", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: HOUR }),
        fc.integer({ min: 0, max: 10 ** 9 }),
        fc.integer({ min: 0, max: 10 ** 10 }),
        (everyMs, anchorMs, offset) => {
          const fired = anchorMs + offset;
          const slot = resolveScheduledAtMs({ kind: "every", everyMs, anchorMs }, fired);
          expect(slot).toBeDefined();
          expect(((slot as number) - anchorMs) % everyMs).toBe(0);
          expect(slot as number).toBeLessThanOrEqual(fired);
          expect(fired - (slot as number)).toBeLessThan(everyMs);
        },
      ),
    );
  });
});

describe("createCronTimer", () => {
  function fakeCron(initial: CronJob[] = []) {
    const jobs = [...initial];
    const cron: CronLike = {
      list: async () => [...jobs],
      add: async (input: CronJobCreate) => {
        const job = {
          ...input,
          id: `cron-${jobs.length + 1}`,
          createdAtMs: 0,
          updatedAtMs: 0,
          state: {},
        } as CronJob;
        jobs.push(job);
        return job;
      },
      remove: async (id) => {
        const i = jobs.findIndex((j) => j.id === id);
        if (i >= 0) jobs.splice(i, 1);
      },
    };
    return { cron, jobs };
  }

  it("registers a recurring cron job and turns its system event into one Job", async () => {
    const { cron, jobs } = fakeCron();
    const adapter = createCronTimer(cron);
    const h = setup();
    const scheduler = createScheduler({
      db: h.db,
      createJob: h.createJob,
      timer: adapter.timer,
      schedules: [daily],
      clock: { now: () => T0 },
    });
    await scheduler.start();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe("friday-ops:daily");
    expect(jobs[0]?.schedule).toEqual(daily.schedule);
    const payload = jobs[0]?.payload;
    const text = payload?.kind === "systemEvent" ? payload.text : "";

    expect(adapter.handleSystemEvent("unrelated event", T0)).toBe(false);
    // The cron fires twice (second one later in the same minute): exactly one Job.
    expect(adapter.handleSystemEvent(text, T0 + 3_000)).toBe(true);
    expect(adapter.handleSystemEvent(text, T0 + 9_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.created).toHaveLength(1);

    await scheduler.stop();
    expect(jobs).toHaveLength(0);
  });

  it("reuses an existing matching cron job after a restart", async () => {
    const { cron, jobs } = fakeCron();
    const h = setup();
    for (let i = 0; i < 2; i++) {
      const s = createScheduler({
        db: h.db,
        createJob: h.createJob,
        timer: createCronTimer(cron).timer,
        schedules: [daily],
      });
      await s.start();
    }
    expect(jobs).toHaveLength(1);
  });
});
