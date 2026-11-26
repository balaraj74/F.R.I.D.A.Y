// Jobs_API unit tests (Requirement 11). The Event_Log is in memory and the Orchestrator is a
// fake, so nothing here calls a model.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { requestTransition } from "../../jobs/engine/state-machine.js";
import { appendEvent, EVENT_TYPES, loadEvents, openEventLog } from "../../jobs/store/index.js";
import {
  cancelJob,
  createJob,
  createJobsApiDeps,
  createJobsApiHandlers,
  digestJobs,
  JOBS_API_METHODS,
  JOBS_API_SCHEMAS,
  JobsApiErrorSchema,
  listJobs,
  pauseJob,
  replayJob,
  resumeJob,
  showJob,
  type JobsApiDeps,
} from "./jobs.js";

function setup(opts: Partial<JobsApiDeps> = {}) {
  const db = openEventLog(":memory:");
  let n = 0;
  let clock = 1_000;
  const deps: JobsApiDeps = {
    db,
    createJob: async (input) => {
      const id = `job-${(n += 1)}`;
      appendEvent(db, {
        jobId: id,
        type: EVENT_TYPES.jobCreated,
        payload: { goal: input.goal, ...(input.type ? { type: input.type } : {}) },
        createdAtMs: (clock += 10),
      });
      return { id };
    },
    pause: (id) => void requestTransition(db, id, "paused"),
    resume: (id) => void requestTransition(db, id, "running"),
    cancel: (id) => void requestTransition(db, id, "cancelled"),
    now: () => clock,
    ...opts,
  };
  const move = (id: string, to: Parameters<typeof requestTransition>[2]) => {
    const r = requestTransition(db, id, to, { nowMs: (clock += 10) });
    if (!r.ok) throw new Error(`setup transition failed: ${r.error.kind}`);
  };
  return { db, deps, move };
}

const eventCount = (db: JobsApiDeps["db"]) => loadEvents(db).length;

async function mkJob(deps: JobsApiDeps, goal = "do it") {
  const res = await createJob(deps, { goal });
  if (!res.ok) throw new Error("create failed");
  return res.value.job.id;
}

describe("job.create", () => {
  it("creates a pending job and the result matches the schema", async () => {
    const { deps } = setup();
    const res = await createJob(deps, { goal: "write docs", type: "research" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.job).toMatchObject({ state: "pending", goal: "write docs", type: "research" });
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.create].result, res.value)).toBe(true);
  });

  it("names every invalid field and appends nothing", async () => {
    const { deps, db } = setup();
    const res = await createJob(deps, { goal: "   ", concurrencyLimit: 99, bogus: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("validation");
    expect(res.error.fields).toEqual(expect.arrayContaining(["goal", "concurrencyLimit", "bogus"]));
    expect(Value.Check(JobsApiErrorSchema, res.error)).toBe(true);
    expect(eventCount(db)).toBe(0);
  });

  it("reports a missing goal and a non-object params", async () => {
    const { deps } = setup();
    const missing = await createJob(deps, {});
    expect(!missing.ok && missing.error.fields).toContain("goal");
    const bad = await createJob(deps, "nope");
    expect(!bad.ok && bad.error.code).toBe("validation");
  });

  it("returns a validation error without creating when the health gate blocks", async () => {
    const { deps, db } = setup({
      canCreateJob: () => ({
        allowed: false,
        reason: "low-disk",
        freeBytes: 1,
        thresholdBytes: 10,
        message: "disk space is low",
      }),
    });
    const res = await createJob(deps, { goal: "x" });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "validation", message: "disk space is low" },
    });
    expect(eventCount(db)).toBe(0);
  });
});

describe("job.list", () => {
  it("returns an empty list when no jobs exist", () => {
    const { deps } = setup();
    expect(listJobs(deps, {})).toEqual({ ok: true, value: { jobs: [], hasMore: false } });
    expect(listJobs(deps)).toEqual({ ok: true, value: { jobs: [], hasMore: false } });
  });

  it("orders newest first, caps pages at 100 and pages with a cursor", async () => {
    const { deps } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 105; i += 1) ids.push(await mkJob(deps));
    const first = listJobs(deps, {});
    if (!first.ok) throw new Error("list failed");
    expect(first.value.jobs).toHaveLength(100);
    expect(first.value.jobs[0]?.id).toBe(ids[104]);
    expect(first.value.hasMore).toBe(true);
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.list].result, first.value)).toBe(true);

    const second = listJobs(deps, { cursor: first.value.nextCursor });
    if (!second.ok) throw new Error("list failed");
    expect(second.value.jobs.map((j) => j.id)).toEqual(ids.slice(0, 5).reverse());
    expect(second.value.hasMore).toBe(false);
  });

  it("rejects a bad cursor and an out-of-range limit", () => {
    const { deps } = setup();
    const a = listJobs(deps, { cursor: "garbage" });
    expect(!a.ok && a.error.field).toBe("cursor");
    const b = listJobs(deps, { limit: 101 });
    expect(!b.ok && b.error.field).toBe("limit");
  });

  it("ignores non-job event owners such as ops:health", async () => {
    const { deps, db } = setup();
    appendEvent(db, { jobId: "ops:health", type: "disk-low", payload: {} });
    await mkJob(deps);
    const res = listJobs(deps, {});
    expect(res.ok && res.value.jobs).toHaveLength(1);
    expect(showJob(deps, { jobId: "ops:health" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("job.show", () => {
  it("returns detail with trace-shaped timeline entries", async () => {
    const { deps } = setup();
    const id = await mkJob(deps);
    const res = showJob(deps, { jobId: id });
    if (!res.ok) throw new Error("show failed");
    expect(res.value.job.timeline[0]).toMatchObject({ stage: "job:created", type: "job-created" });
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.show].result, res.value)).toBe(true);
  });

  it("returns not_found with the requested id", () => {
    const { deps } = setup();
    expect(showJob(deps, { jobId: "missing" })).toEqual({
      ok: false,
      error: { code: "not_found", message: "job not found: missing", jobId: "missing" },
    });
  });
});

describe("pause / resume / cancel", () => {
  it("pauses a running job, resumes it, then cancels it", async () => {
    const { deps, move } = setup();
    const id = await mkJob(deps);
    move(id, "running");
    const paused = await pauseJob(deps, { jobId: id });
    expect(paused.ok && paused.value.job.state).toBe("paused");
    const resumed = await resumeJob(deps, { jobId: id });
    expect(resumed.ok && resumed.value.job.state).toBe("running");
    const cancelled = await cancelJob(deps, { jobId: id });
    expect(cancelled.ok && cancelled.value.job.state).toBe("cancelled");
    if (cancelled.ok) {
      expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.cancel].result, cancelled.value)).toBe(
        true,
      );
    }
  });

  it("rejects impossible transitions, names the current state and appends nothing", async () => {
    const { deps, db, move } = setup();
    const id = await mkJob(deps);
    move(id, "cancelled");
    const before = eventCount(db);
    const pause = await pauseJob(deps, { jobId: id });
    expect(pause).toMatchObject({
      ok: false,
      error: { code: "invalid_transition", currentState: "cancelled", jobId: id },
    });
    const resume = await resumeJob(deps, { jobId: id });
    expect(!resume.ok && resume.error.code).toBe("invalid_transition");
    const cancel = await cancelJob(deps, { jobId: id });
    expect(!cancel.ok && cancel.error.currentState).toBe("cancelled");
    expect(eventCount(db)).toBe(before);
    if (!pause.ok) expect(Value.Check(JobsApiErrorSchema, pause.error)).toBe(true);
  });

  it("rejects resume on a job that is not paused, including waiting_approval", async () => {
    const { deps, move, db } = setup();
    const id = await mkJob(deps);
    move(id, "running");
    move(id, "waiting_approval");
    const before = eventCount(db);
    const res = await resumeJob(deps, { jobId: id });
    expect(res).toMatchObject({
      ok: false,
      error: { code: "invalid_transition", currentState: "waiting_approval" },
    });
    expect(eventCount(db)).toBe(before);
  });

  it("returns not_found and validation errors without calling the deps", async () => {
    let calls = 0;
    const { deps, db } = setup({ pause: () => void (calls += 1) });
    expect(await pauseJob(deps, { jobId: "nope" })).toMatchObject({
      ok: false,
      error: { code: "not_found", jobId: "nope" },
    });
    expect(await pauseJob(deps, {})).toMatchObject({
      ok: false,
      error: { code: "validation", field: "jobId" },
    });
    expect(calls).toBe(0);
    expect(eventCount(db)).toBe(0);
  });
});

describe("job.replay", () => {
  it("returns events ascending by timestamp, ties in append order", async () => {
    const { deps, db } = setup();
    const id = await mkJob(deps);
    // Appended out of timestamp order on purpose.
    appendEvent(db, { jobId: id, type: "note-b", createdAtMs: 5_000 });
    appendEvent(db, { jobId: id, type: "note-a", createdAtMs: 2_000 });
    appendEvent(db, { jobId: id, type: "note-c", createdAtMs: 5_000 });
    const res = replayJob(deps, { jobId: id });
    if (!res.ok) throw new Error("replay failed");
    const times = res.value.events.map((e) => e.createdAtMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(res.value.events.map((e) => e.type).slice(-3)).toEqual(["note-a", "note-b", "note-c"]);
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.replay].result, res.value)).toBe(true);
  });

  it("returns not_found for an unknown job", () => {
    const { deps } = setup();
    expect(replayJob(deps, { jobId: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("job.digest", () => {
  it("lists jobs whose status changed after sinceMs", async () => {
    const { deps, move } = setup();
    const a = await mkJob(deps);
    const b = await mkJob(deps);
    move(a, "cancelled");
    const all = digestJobs(deps, {});
    if (!all.ok) throw new Error("digest failed");
    expect(all.value.entries.map((e) => e.jobId).sort()).toEqual([a, b].sort());
    const cancelled = all.value.entries.find((e) => e.jobId === a);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled?.completedAtMs).toBe(cancelled?.changedAtMs);
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.digest].result, all.value)).toBe(true);

    const since = digestJobs(deps, { sinceMs: cancelled?.changedAtMs ?? 0 });
    expect(since.ok && since.value.entries).toEqual([]);
    const bad = digestJobs(deps, { sinceMs: -1 });
    expect(!bad.ok && bad.error.field).toBe("sinceMs");
  });
});

describe("createJobsApiDeps and handlers", () => {
  it("falls back to validated state transitions when the orchestrator lacks controls", async () => {
    const { db, move, deps: base } = setup();
    const deps = createJobsApiDeps({
      db,
      orchestrator: {
        createJob: base.createJob,
        awaitTerminal: async () => {
          throw new Error("unused");
        },
        getJob: () => undefined,
      },
    });
    const id = await mkJob(deps);
    move(id, "running");
    const res = await pauseJob(deps, { jobId: id });
    expect(res.ok && res.value.job.state).toBe("paused");
  });

  it("responds with details for API errors and ok for success", async () => {
    const { deps } = setup();
    const handlers = createJobsApiHandlers(() => deps);
    const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
    const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
      calls.push({ ok, payload, error });
    const call = (method: string, params: unknown) =>
      (handlers[method] as (o: unknown) => Promise<void>)({ params, respond });
    await call(JOBS_API_METHODS.list, {});
    await call(JOBS_API_METHODS.show, { jobId: "nope" });
    expect(calls[0]).toMatchObject({ ok: true, payload: { jobs: [], hasMore: false } });
    expect(calls[1]).toMatchObject({
      ok: false,
      error: { details: { code: "not_found", jobId: "nope" } },
    });
  });
});
