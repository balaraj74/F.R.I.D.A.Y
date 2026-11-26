import { describe, expect, it } from "vitest";

import {
  appendEvent,
  EVENT_TYPES,
  JOB_STATES,
  loadEvents,
  openEventLog,
  projectJobState,
} from "../store/index.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  grantLease,
  heartbeat,
  requestTransition,
  TERMINAL_JOB_STATES,
} from "./index.js";

function newJob(jobId = "j1") {
  const db = openEventLog(":memory:");
  appendEvent(db, { jobId, type: EVENT_TYPES.jobCreated, payload: {}, createdAtMs: 1 });
  return db;
}

function stateOf(db: ReturnType<typeof openEventLog>, jobId = "j1") {
  return projectJobState(loadEvents(db, jobId)).jobs[jobId]?.state;
}

describe("canTransition", () => {
  it("accepts the Req 5.4 set and the paused rows", () => {
    const allowed: [string, string][] = [
      ["pending", "running"],
      ["running", "waiting_approval"],
      ["running", "verifying"],
      ["running", "failed"],
      ["waiting_approval", "running"],
      ["waiting_approval", "cancelled"],
      ["verifying", "done"],
      ["verifying", "running"],
      ["verifying", "failed"],
      ["running", "paused"],
      ["paused", "running"],
      ["paused", "cancelled"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransition(from as never, to as never), `${from}->${to}`).toBe(true);
    }
  });

  it("allows every non-terminal state to reach cancelled", () => {
    for (const s of JOB_STATES) {
      expect(canTransition(s, "cancelled")).toBe(!TERMINAL_JOB_STATES.includes(s));
    }
  });

  it("rejects every transition out of a terminal state", () => {
    for (const from of TERMINAL_JOB_STATES) {
      expect(ALLOWED_TRANSITIONS[from]).toEqual([]);
      for (const to of JOB_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it("rejects disallowed and self transitions", () => {
    expect(canTransition("pending", "done")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
    expect(canTransition("paused", "verifying")).toBe(false);
    expect(canTransition("bogus" as never, "running")).toBe(false);
  });
});

describe("requestTransition", () => {
  it("appends exactly one job-state-changed event for an allowed transition", () => {
    const db = newJob();
    const before = loadEvents(db).length;
    const res = requestTransition(db, "j1", "running", { reason: "go", nowMs: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.type).toBe(EVENT_TYPES.jobStateChanged);
    expect(res.value.createdAtMs).toBe(5);
    expect(loadEvents(db).length).toBe(before + 1);
    expect(stateOf(db)).toBe("running");
    expect(projectJobState(loadEvents(db)).jobs.j1?.stateReason).toBe("go");
  });

  it("supports pause, resume and cancel", () => {
    const db = newJob();
    for (const to of ["running", "paused", "running", "paused", "cancelled"] as const) {
      expect(requestTransition(db, "j1", to).ok).toBe(true);
    }
    expect(stateOf(db)).toBe("cancelled");
  });

  it("rejects a disallowed transition without appending an event", () => {
    const db = newJob();
    const before = loadEvents(db).length;
    const res = requestTransition(db, "j1", "done");
    expect(res).toEqual({
      ok: false,
      error: { kind: "not-allowed", jobId: "j1", from: "pending", to: "done" },
    });
    expect(loadEvents(db).length).toBe(before);
    expect(stateOf(db)).toBe("pending");
  });

  it("rejects everything from terminal states without appending", () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      const db = newJob();
      requestTransition(db, "j1", terminal === "failed" ? "running" : "cancelled");
      if (terminal === "failed") requestTransition(db, "j1", "failed");
      const before = loadEvents(db).length;
      for (const to of JOB_STATES) {
        expect(requestTransition(db, "j1", to).ok).toBe(false);
      }
      expect(loadEvents(db).length).toBe(before);
    }
  });

  it("returns not-found for an unknown job and appends nothing", () => {
    const db = newJob();
    const before = loadEvents(db).length;
    const res = requestTransition(db, "nope", "running");
    expect(res).toEqual({ ok: false, error: { kind: "not-found", jobId: "nope" } });
    expect(loadEvents(db).length).toBe(before);
  });

  it("rejects an unknown target state", () => {
    const db = newJob();
    const res = requestTransition(db, "j1", "bogus" as never);
    expect(res.ok).toBe(false);
    expect(loadEvents(db).length).toBe(1);
  });

  it("reports write-failed and leaves state unchanged when the append throws", () => {
    const db = newJob();
    db.exec(
      `CREATE TRIGGER block_state BEFORE INSERT ON events WHEN NEW.type = 'job-state-changed'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const before = loadEvents(db).length;
    const res = requestTransition(db, "j1", "running");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("write-failed");
    expect(loadEvents(db).length).toBe(before);
    expect(stateOf(db)).toBe("pending");
  });
});

describe("leases", () => {
  it("grants a lease expiring 30s after grant", () => {
    expect(grantLease(1_000, "s1")).toEqual({ stepId: "s1", expiresAtMs: 31_000 });
    expect(grantLease(0).expiresAtMs).toBe(30_000);
  });

  it("extends from the heartbeat time when received before expiry", () => {
    const lease = grantLease(0, "s1");
    const res = heartbeat(lease, 29_999);
    expect(res).toEqual({ ok: true, value: { stepId: "s1", expiresAtMs: 59_999 } });
    expect(lease.expiresAtMs).toBe(30_000);
  });

  it("rejects a heartbeat at or after expiry and leaves the lease unchanged", () => {
    const lease = grantLease(0, "s1");
    expect(heartbeat(lease, 30_000)).toEqual({ ok: false, error: "expired" });
    expect(heartbeat(lease, 45_000)).toEqual({ ok: false, error: "expired" });
    expect(lease).toEqual({ stepId: "s1", expiresAtMs: 30_000 });
  });
});
