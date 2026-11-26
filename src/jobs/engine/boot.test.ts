import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendEvent,
  EVENT_TYPES,
  loadEvents,
  openEventLog,
  projectJobState,
} from "../store/index.js";
import {
  reclaimStaleLeases,
  resetJobEngineRestoreForTests,
  restoreJobEngineOnce,
  RESUME_WINDOW_MS,
  type ResumeStepRequest,
} from "./boot.js";

type Db = ReturnType<typeof openEventLog>;

function seedJob(db: Db, jobId: string, state: "running" | "paused" | "done" = "running") {
  appendEvent(db, { jobId, type: EVENT_TYPES.jobCreated, payload: {}, createdAtMs: 1 });
  appendEvent(db, {
    jobId,
    type: EVENT_TYPES.jobStateChanged,
    payload: { to: "running" },
    createdAtMs: 2,
  });
  if (state !== "running") {
    appendEvent(db, {
      jobId,
      type: EVENT_TYPES.jobStateChanged,
      payload: { to: state === "done" ? "verifying" : "paused" },
      createdAtMs: 3,
    });
    if (state === "done") {
      appendEvent(db, {
        jobId,
        type: EVENT_TYPES.jobStateChanged,
        payload: { to: "done" },
        createdAtMs: 4,
      });
    }
  }
}

function startStep(db: Db, jobId: string, stepId: string, expiresAtMs: number) {
  appendEvent(db, {
    jobId,
    taskId: `t-${stepId}`,
    stepId,
    type: EVENT_TYPES.stepStarted,
    payload: { leaseExpiresAtMs: expiresAtMs },
    createdAtMs: 10,
  });
}

function completeStep(db: Db, jobId: string, stepId: string) {
  appendEvent(db, {
    jobId,
    taskId: `t-${stepId}`,
    stepId,
    type: EVENT_TYPES.stepCompleted,
    createdAtMs: 20,
  });
}

function reclaimedEvents(db: Db) {
  return loadEvents(db).filter((e) => e.type === EVENT_TYPES.leaseReclaimed);
}

describe("reclaimStaleLeases", () => {
  it("appends one lease-reclaimed event per running Step with an expired lease", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "expired-a", 1_000);
    startStep(db, "j1", "expired-b", 4_999);
    startStep(db, "j1", "live", 5_000); // expiry == boot time is not "earlier"
    startStep(db, "j1", "done", 1_000);
    completeStep(db, "j1", "done");

    const appended = reclaimStaleLeases(db, 5_000);

    expect(appended.map((e) => e.stepId).toSorted()).toEqual(["expired-a", "expired-b"]);
    expect(appended.every((e) => e.type === EVENT_TYPES.leaseReclaimed)).toBe(true);
    expect(appended[0]?.taskId).toBe("t-expired-a");
    const steps = projectJobState(loadEvents(db)).jobs.j1?.steps ?? {};
    expect(steps["expired-a"]?.status).toBe("reclaimed");
    expect(steps["expired-b"]?.status).toBe("reclaimed");
    expect(steps.live?.status).toBe("running");
    expect(steps.done?.status).toBe("completed");
  });

  it("is idempotent: a second pass appends nothing", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 1_000);
    expect(reclaimStaleLeases(db, 5_000)).toHaveLength(1);
    expect(reclaimStaleLeases(db, 5_000)).toHaveLength(0);
    expect(reclaimedEvents(db)).toHaveLength(1);
  });

  it("does nothing on an empty log", () => {
    expect(reclaimStaleLeases(openEventLog(":memory:"), 5_000)).toEqual([]);
  });

  it("logs and skips a Step whose append fails", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 1_000);
    db.exec(
      `CREATE TRIGGER block_reclaim BEFORE INSERT ON events WHEN NEW.type = 'lease-reclaimed'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(reclaimStaleLeases(db, 5_000)).toEqual([]);
  });
});

describe("restoreJobEngineOnce", () => {
  beforeEach(() => resetJobEngineRestoreForTests());

  it("reclaims stale leases then resumes interrupted Steps in log order, skipping completed ones", async () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 100);
    completeStep(db, "j1", "s1");
    startStep(db, "j1", "s2", 100); // stale, no completion
    startStep(db, "j1", "s3", 999_999); // lease still valid, no completion
    const resumeStep = vi.fn<(r: ResumeStepRequest) => void>();

    const res = restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 });

    expect(res.reclaimed.map((e) => e.stepId)).toEqual(["s2"]);
    expect(resumeStep.mock.calls.map(([r]) => r.stepId)).toEqual(["s2", "s3"]);
    expect(resumeStep.mock.calls.map(([r]) => r.reclaimed)).toEqual([true, false]);
    expect(resumeStep.mock.calls[0]?.[0].resumeByMs).toBe(5_000 + RESUME_WINDOW_MS);
    expect(resumeStep.mock.calls[0]?.[0].taskId).toBe("t-s2");
  });

  it("never resumes completed Steps, or Steps of terminal or paused Jobs", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "finished", "done");
    startStep(db, "finished", "f1", 100);
    seedJob(db, "held", "paused");
    startStep(db, "held", "h1", 100);
    seedJob(db, "j1");
    startStep(db, "j1", "c1", 100);
    completeStep(db, "j1", "c1");
    const resumeStep = vi.fn();

    restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 });

    expect(resumeStep).not.toHaveBeenCalled();
  });

  it("runs only once per process until the test reset helper is called", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 100);
    const resumeStep = vi.fn();

    restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 });
    const second = restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 });
    expect(second).toEqual({ reclaimed: [], resumed: [] });
    expect(resumeStep).toHaveBeenCalledTimes(1);

    resetJobEngineRestoreForTests();
    restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 });
    expect(resumeStep).toHaveBeenCalledTimes(2);
  });

  it("swallows a throwing and a rejecting resume callback and still resumes the rest", async () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 100);
    startStep(db, "j1", "s2", 100);
    startStep(db, "j1", "s3", 100);
    const seen: string[] = [];
    const resumeStep = (r: ResumeStepRequest) => {
      seen.push(r.stepId);
      if (r.stepId === "s1") throw new Error("sync boom");
      if (r.stepId === "s2") return Promise.reject(new Error("async boom"));
    };

    expect(() => restoreJobEngineOnce(db, { resumeStep, bootTimeMs: 5_000 })).not.toThrow();
    await Promise.resolve();
    expect(seen).toEqual(["s1", "s2", "s3"]);
  });

  it("swallows a failure while loading the log", () => {
    const db = openEventLog(":memory:");
    db.exec("DROP TABLE events");
    const resumeStep = vi.fn();
    expect(() => restoreJobEngineOnce(db, { resumeStep })).not.toThrow();
    expect(resumeStep).not.toHaveBeenCalled();
  });

  it("only reclaims when no resume callback is supplied", () => {
    const db = openEventLog(":memory:");
    seedJob(db, "j1");
    startStep(db, "j1", "s1", 100);
    const res = restoreJobEngineOnce(db, { bootTimeMs: 5_000 });
    expect(res.reclaimed).toHaveLength(1);
    expect(res.resumed).toEqual([]);
  });
});
