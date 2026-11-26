// Jobs_API contract tests (Requirements 11.2, 11.8, 11.10).
// Every method's requests, success responses and error responses are validated against the
// TypeBox schema in jobs.schema.ts. The CLI is wired to the real Gateway handlers so exit
// codes and stderr are checked against genuine error responses.
import { Value } from "@sinclair/typebox/value";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerJobsCli, JOBS_GATEWAY_TIMEOUT_MS, type JobsCliDeps } from "../../cli/jobs.js";
import { requestTransition } from "../../jobs/engine/state-machine.js";
import { appendEvent, EVENT_TYPES, openEventLog } from "../../jobs/store/index.js";
import {
  createJobsApiHandlers,
  JOBS_API_METHODS,
  JOBS_API_SCHEMAS,
  JobsApiErrorSchema,
  type JobsApiDeps,
} from "./jobs.js";

type Reply = { ok: boolean; payload?: unknown; error?: { message: string; details?: unknown } };

function setup() {
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
  };
  const handlers = createJobsApiHandlers(() => deps);
  const call = async (method: string, params: unknown): Promise<Reply> => {
    let reply: Reply | undefined;
    await (handlers[method] as (o: unknown) => Promise<void>)({
      params,
      respond: (ok: boolean, payload?: unknown, error?: Reply["error"]) => {
        reply = { ok, payload, error };
      },
    });
    if (!reply) throw new Error("handler did not respond");
    return reply;
  };
  const move = (id: string, to: Parameters<typeof requestTransition>[2]) => {
    const r = requestTransition(db, id, to, { nowMs: (clock += 10) });
    if (!r.ok) throw new Error(`setup transition failed: ${r.error.kind}`);
  };
  return { db, deps, call, move };
}

const METHODS = Object.values(JOBS_API_METHODS);
const VALID_PARAMS: Record<string, unknown> = {
  [JOBS_API_METHODS.create]: { goal: "g", type: "coding", concurrencyLimit: 4 },
  [JOBS_API_METHODS.list]: { limit: 10 },
  [JOBS_API_METHODS.show]: { jobId: "j" },
  [JOBS_API_METHODS.pause]: { jobId: "j" },
  [JOBS_API_METHODS.resume]: { jobId: "j" },
  [JOBS_API_METHODS.cancel]: { jobId: "j" },
  [JOBS_API_METHODS.replay]: { jobId: "j" },
  [JOBS_API_METHODS.digest]: { sinceMs: 0 },
};
const INVALID_PARAMS: Record<string, unknown> = {
  [JOBS_API_METHODS.create]: { goal: "   " },
  [JOBS_API_METHODS.list]: { limit: 0 },
  [JOBS_API_METHODS.show]: {},
  [JOBS_API_METHODS.pause]: { jobId: "" },
  [JOBS_API_METHODS.resume]: { jobId: 5 },
  [JOBS_API_METHODS.cancel]: { jobId: "j", extra: true },
  [JOBS_API_METHODS.replay]: {},
  [JOBS_API_METHODS.digest]: { sinceMs: -1 },
};

describe("Jobs_API contract: requests", () => {
  it("has a params and result schema for every method", () => {
    expect(Object.keys(JOBS_API_SCHEMAS).sort()).toEqual([...METHODS].sort());
  });

  it.each(METHODS)("%s: accepts valid params and rejects invalid params in the schema", (m) => {
    const { params } = JOBS_API_SCHEMAS[m];
    expect(Value.Check(params, VALID_PARAMS[m])).toBe(true);
    expect(Value.Check(params, INVALID_PARAMS[m])).toBe(false);
  });

  it.each(METHODS)("%s: params that fail the schema yield a validation error", async (m) => {
    const { call, db } = setup();
    const reply = await call(m, INVALID_PARAMS[m]);
    expect(reply.ok).toBe(false);
    const details = reply.error?.details;
    expect(Value.Check(JobsApiErrorSchema, details)).toBe(true);
    expect(details).toMatchObject({ code: "validation" });
    expect(reply.error?.message).toBe((details as { message: string }).message);
    // A rejected request must not write anything to the Event_Log.
    expect(db.prepare("SELECT COUNT(*) AS c FROM events").get()).toMatchObject({ c: 0 });
  });
});

describe("Jobs_API contract: responses", () => {
  it("every success response validates against its method's result schema", async () => {
    const { call, move } = setup();
    const created = await call(JOBS_API_METHODS.create, { goal: "ship it", type: "operations" });
    const id = (created.payload as { job: { id: string } }).job.id;
    move(id, "running");
    const seen: Array<[string, Reply]> = [
      [JOBS_API_METHODS.create, created],
      [JOBS_API_METHODS.list, await call(JOBS_API_METHODS.list, {})],
      [JOBS_API_METHODS.show, await call(JOBS_API_METHODS.show, { jobId: id })],
      [JOBS_API_METHODS.pause, await call(JOBS_API_METHODS.pause, { jobId: id })],
      [JOBS_API_METHODS.resume, await call(JOBS_API_METHODS.resume, { jobId: id })],
      [JOBS_API_METHODS.replay, await call(JOBS_API_METHODS.replay, { jobId: id })],
      [JOBS_API_METHODS.digest, await call(JOBS_API_METHODS.digest, {})],
      [JOBS_API_METHODS.cancel, await call(JOBS_API_METHODS.cancel, { jobId: id })],
    ];
    expect(new Set(seen.map(([m]) => m))).toEqual(new Set(METHODS));
    for (const [m, reply] of seen) {
      expect(reply.ok, m).toBe(true);
      expect(
        Value.Check(JOBS_API_SCHEMAS[m as keyof typeof JOBS_API_SCHEMAS].result, reply.payload),
        m,
      ).toBe(true);
    }
  });

  it("empty list and digest responses validate", async () => {
    const { call } = setup();
    const list = await call(JOBS_API_METHODS.list, {});
    const digest = await call(JOBS_API_METHODS.digest, {});
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.list].result, list.payload)).toBe(true);
    expect(Value.Check(JOBS_API_SCHEMAS[JOBS_API_METHODS.digest].result, digest.payload)).toBe(
      true,
    );
  });

  it("the result schemas reject a response with a missing or unknown field", () => {
    const { result } = JOBS_API_SCHEMAS[JOBS_API_METHODS.list];
    expect(Value.Check(result, { jobs: [] })).toBe(false);
    expect(Value.Check(result, { jobs: [], hasMore: false, extra: 1 })).toBe(false);
  });
});

describe("Jobs_API contract: error responses", () => {
  it.each([
    JOBS_API_METHODS.show,
    JOBS_API_METHODS.pause,
    JOBS_API_METHODS.resume,
    JOBS_API_METHODS.cancel,
    JOBS_API_METHODS.replay,
  ] as const)("%s: unknown job returns a not_found error matching the schema", async (m) => {
    const { call } = setup();
    const reply = await call(m, { jobId: "missing" });
    expect(reply.ok).toBe(false);
    expect(Value.Check(JobsApiErrorSchema, reply.error?.details)).toBe(true);
    expect(reply.error?.details).toMatchObject({ code: "not_found", jobId: "missing" });
  });

  it.each([JOBS_API_METHODS.pause, JOBS_API_METHODS.resume, JOBS_API_METHODS.cancel] as const)(
    "%s: a terminal job returns an invalid_transition error naming the current state",
    async (m) => {
      const { call, move, db } = setup();
      const created = await call(JOBS_API_METHODS.create, { goal: "x" });
      const id = (created.payload as { job: { id: string } }).job.id;
      move(id, "cancelled");
      const before = db.prepare("SELECT COUNT(*) AS c FROM events").get();
      const reply = await call(m, { jobId: id });
      expect(reply.ok).toBe(false);
      expect(Value.Check(JobsApiErrorSchema, reply.error?.details)).toBe(true);
      expect(reply.error?.details).toMatchObject({
        code: "invalid_transition",
        jobId: id,
        currentState: "cancelled",
      });
      expect(db.prepare("SELECT COUNT(*) AS c FROM events").get()).toEqual(before);
    },
  );

  it("a validation error lists every invalid field", async () => {
    const { call } = setup();
    const reply = await call(JOBS_API_METHODS.create, { goal: "", concurrencyLimit: 99, x: 1 });
    const details = reply.error?.details as { fields?: string[] };
    expect(Value.Check(JobsApiErrorSchema, details)).toBe(true);
    expect(details.fields).toEqual(expect.arrayContaining(["goal", "concurrencyLimit", "x"]));
  });

  it("the error schema rejects an unknown code or extra property", () => {
    expect(Value.Check(JobsApiErrorSchema, { code: "boom", message: "m" })).toBe(false);
    expect(Value.Check(JobsApiErrorSchema, { code: "validation", message: "" })).toBe(false);
    expect(Value.Check(JobsApiErrorSchema, { code: "not_found", message: "m", extra: 1 })).toBe(
      false,
    );
    for (const code of ["validation", "not_found", "invalid_transition"]) {
      expect(Value.Check(JobsApiErrorSchema, { code, message: "m" })).toBe(true);
    }
  });

  it("an unexpected dependency failure is reported as an error, not a Jobs_API error", async () => {
    const { deps } = setup();
    const handlers = createJobsApiHandlers(() => {
      throw new Error("db offline");
    });
    let reply: Reply | undefined;
    await (handlers[JOBS_API_METHODS.list] as (o: unknown) => Promise<void>)({
      params: {},
      respond: (ok: boolean, payload?: unknown, error?: Reply["error"]) => {
        reply = { ok, payload, error };
      },
    });
    expect(deps).toBeDefined();
    expect(reply?.ok).toBe(false);
    expect(reply?.error?.message).toBe("db offline");
    expect(reply?.error?.details).toBeUndefined();
  });
});

// --- CLI against the real handlers ---------------------------------------------------

function cliHarness() {
  const s = setup();
  const logs: string[] = [];
  const errors: string[] = [];
  const exit = vi.fn();
  const deps: JobsCliDeps = {
    runtime: {
      log: (...a: unknown[]) => void logs.push(a.join(" ")),
      error: (...a: unknown[]) => void errors.push(a.join(" ")),
      exit: exit as unknown as (code: number) => never,
    },
    callGateway: async (req) => {
      const reply = await s.call(req.method, req.params);
      if (reply.ok) return reply.payload;
      throw Object.assign(new Error(reply.error?.message), { details: reply.error?.details });
    },
  };
  const run = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerJobsCli(program, deps);
    await program.parseAsync(["node", "friday", "jobs", ...args]);
  };
  return { ...s, logs, errors, exit, deps, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("friday jobs CLI against the Jobs_API", () => {
  it("successful commands print to stdout, write nothing to stderr and do not exit non-zero", async () => {
    const h = cliHarness();
    await h.run("create", "do work");
    await h.run("list");
    await h.run("show", "job-1");
    await h.run("replay", "job-1");
    await h.run("digest");
    expect(h.errors).toEqual([]);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.logs[0]).toBe("Created job job-1 (pending)");
  });

  it.each(["show", "pause", "resume", "cancel", "replay"])(
    "%s on an unknown job prints a not_found error to stderr and exits 1",
    async (cmd) => {
      const h = cliHarness();
      await h.run(cmd, "ghost");
      expect(h.errors).toEqual(["Error (not_found): job not found: ghost", "  job: ghost"]);
      expect(h.logs).toEqual([]);
      expect(h.exit).toHaveBeenCalledTimes(1);
      expect(h.exit).toHaveBeenCalledWith(1);
    },
  );

  it.each(["pause", "resume", "cancel"])(
    "%s on a cancelled job prints invalid_transition with the state and exits 1",
    async (cmd) => {
      const h = cliHarness();
      await h.run("create", "x");
      h.move("job-1", "cancelled");
      h.logs.length = 0;
      await h.run(cmd, "job-1");
      expect(h.errors[0]).toMatch(/^Error \(invalid_transition\): /);
      expect(h.errors.join("\n")).toContain("current state: cancelled");
      expect(h.errors.join("\n")).toContain("job: job-1");
      expect(h.logs).toEqual([]);
      expect(h.exit).toHaveBeenCalledWith(1);
    },
  );

  it("create with a blank goal prints the validation error and field to stderr and exits 1", async () => {
    const h = cliHarness();
    await h.run("create", "   ");
    expect(h.errors[0]).toMatch(/^Error \(validation\): /);
    expect(h.errors).toContain("  field: goal");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("list with an out-of-range limit is rejected by the API with a validation error", async () => {
    const h = cliHarness();
    await h.run("list", "--limit", "101");
    expect(h.errors).toContain("  field: limit");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("--json does not change the exit code or stderr output of a failure", async () => {
    const h = cliHarness();
    await h.run("show", "ghost", "--json");
    expect(h.errors[0]).toBe("Error (not_found): job not found: ghost");
    expect(h.logs).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

describe("friday jobs CLI: unreachable Gateway timeout", () => {
  const COMMANDS: string[][] = [
    ["create", "g"],
    ["list"],
    ["show", "j"],
    ["pause", "j"],
    ["resume", "j"],
    ["cancel", "j"],
    ["replay", "j"],
    ["digest"],
  ];

  it.each(COMMANDS)(
    "%s gives up after exactly 10 seconds, prints to stderr and exits 1",
    async (...args) => {
      vi.useFakeTimers();
      const h = cliHarness();
      h.deps.callGateway = () => new Promise(() => undefined); // Gateway never answers
      const done = h.run(...args);
      await vi.advanceTimersByTimeAsync(JOBS_GATEWAY_TIMEOUT_MS - 1);
      expect(h.exit).not.toHaveBeenCalled();
      expect(h.errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(JOBS_GATEWAY_TIMEOUT_MS).toBe(10_000);
      expect(h.errors).toEqual(["Error: Gateway did not respond within 10 seconds."]);
      expect(h.logs).toEqual([]);
      expect(h.exit).toHaveBeenCalledWith(1);
    },
  );

  it("a Gateway that rejects after the timeout does not cause an unhandled rejection", async () => {
    vi.useFakeTimers();
    const h = cliHarness();
    let rejectLate: (e: Error) => void = () => undefined;
    h.deps.callGateway = () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      });
    const done = h.run("list");
    await vi.advanceTimersByTimeAsync(JOBS_GATEWAY_TIMEOUT_MS);
    await done;
    rejectLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.errors).toEqual(["Error: Gateway did not respond within 10 seconds."]);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});
