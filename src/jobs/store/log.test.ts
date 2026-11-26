import { describe, expect, it } from "vitest";

import {
  appendEvent,
  EventLogWriteError,
  loadEvents,
  loadEventsWithWarnings,
  openEventLog,
  projectJobState,
} from "./index.js";

describe("appendEvent / loadEvents", () => {
  it("creates the events table and index", () => {
    const db = openEventLog(":memory:");
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('events','idx_events_job')")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names.sort()).toEqual(["events", "idx_events_job"]);
  });

  it("round-trips events in ascending id order and filters by job", () => {
    const db = openEventLog(":memory:");
    const a = appendEvent(db, { jobId: "j1", type: "x", payload: { n: 1 }, createdAtMs: 10 });
    const b = appendEvent(db, {
      jobId: "j2",
      taskId: "t",
      stepId: "s",
      type: "y",
      createdAtMs: 20,
    });
    appendEvent(db, { jobId: "j1", type: "z", payload: [1, "two"], createdAtMs: 30 });
    expect(b.id).toBeGreaterThan(a.id);
    expect(loadEvents(db).map((e) => e.type)).toEqual(["x", "y", "z"]);
    expect(loadEvents(db, "j1").map((e) => e.type)).toEqual(["x", "z"]);
    expect(loadEvents(db)[1]).toEqual(b);
  });

  it("appends nothing and throws when the write fails", () => {
    const db = openEventLog(":memory:");
    appendEvent(db, { jobId: "j", type: "ok" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendEvent(db, { jobId: "j", type: "bad", payload: cyclic })).toThrow(
      EventLogWriteError,
    );
    expect(() => appendEvent(db, { jobId: "", type: "bad" })).toThrow(EventLogWriteError);
    db.close();
    expect(() => appendEvent(db, { jobId: "j", type: "closed" })).toThrow(EventLogWriteError);
  });

  it("rolls back so the connection stays usable after a SQLite failure", () => {
    const db = openEventLog(":memory:");
    db.exec(
      "CREATE TRIGGER no_boom BEFORE INSERT ON events WHEN NEW.type = 'boom' BEGIN SELECT RAISE(ABORT, 'nope'); END;",
    );
    expect(() => appendEvent(db, { jobId: "j", type: "boom" })).toThrow(EventLogWriteError);
    appendEvent(db, { jobId: "j", type: "fine" });
    expect(loadEvents(db).map((e) => e.type)).toEqual(["fine"]);
  });

  it("drops a truncated final row and keeps earlier events", () => {
    const db = openEventLog(":memory:");
    appendEvent(db, { jobId: "j", type: "a" });
    appendEvent(db, { jobId: "j", type: "b" });
    db.prepare(
      "INSERT INTO events (job_id, type, payload, created_at_ms) VALUES ('j', 'c', '{\"half\":', 1)",
    ).run();
    const { events, warnings } = loadEventsWithWarnings(db);
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ position: "final", eventId: 3 });
    expect(loadEvents(db)).toHaveLength(2);
  });
});

describe("projectJobState", () => {
  const mk = (
    id: number,
    type: string,
    extra: { taskId?: string; stepId?: string; payload?: unknown } = {},
  ) => ({ id, jobId: "j", type, createdAtMs: id * 100, payload: extra.payload ?? {}, ...extra });

  const events = [
    mk(1, "job-created", { payload: { type: "coding", goal: "g" } }),
    mk(2, "job-state-changed", { payload: { to: "running" } }),
    mk(3, "task-created", { taskId: "t1", payload: { role: "builder", dependsOn: [] } }),
    mk(4, "step-started", { taskId: "t1", stepId: "s1", payload: { leaseExpiresAtMs: 30_000 } }),
    mk(5, "lease-heartbeat", { stepId: "s1", payload: { expiresAtMs: 60_000 } }),
    mk(6, "step-completed", { taskId: "t1", stepId: "s1" }),
    mk(7, "task-state-changed", { taskId: "t1", payload: { to: "done" } }),
  ];

  it("folds events into job, task and step state", () => {
    const job = projectJobState(events).jobs.j!;
    expect(job).toMatchObject({ type: "coding", goal: "g", state: "running" });
    expect(job.tasks.t1).toMatchObject({ role: "builder", state: "done" });
    expect(job.steps.s1).toMatchObject({ status: "completed", attempt: 1 });
    expect(job.steps.s1!.lease).toBeUndefined();
    expect(job.timeline.map((t) => t.eventId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("extends the lease on heartbeat while the step is running", () => {
    const job = projectJobState(events.slice(0, 5)).jobs.j!;
    expect(job.steps.s1!.lease).toEqual({ expiresAtMs: 60_000 });
  });

  it("is deterministic, order-independent and does not mutate input", () => {
    const copy = structuredClone(events);
    const once = projectJobState(events);
    expect(projectJobState(events)).toEqual(once);
    expect(projectJobState([...events].reverse())).toEqual(once);
    expect(events).toEqual(copy);
  });

  it("ignores unknown event types and invalid states", () => {
    const job = projectJobState([
      mk(1, "something-new"),
      mk(2, "job-state-changed", { payload: { to: "bogus" } }),
    ]).jobs.j!;
    expect(job.state).toBe("pending");
    expect(job.timeline).toHaveLength(2);
  });
});
