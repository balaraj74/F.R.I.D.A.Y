import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSummary, JobTraceEvent } from "../gateway/rpc/jobs.schema.js";
import {
  JOBS_GATEWAY_TIMEOUT_MS,
  formatJobsError,
  registerJobsCli,
  type JobsCliDeps,
  type JobsGatewayRequest,
} from "./jobs.js";

const USAGE = { inputTokens: 1, outputTokens: 2, totalTokens: 3, elapsedMs: 4 };

function summary(id: string, extra: Partial<JobSummary> = {}): JobSummary {
  return {
    id,
    state: "running",
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    taskCount: 1,
    usage: USAGE,
    ...extra,
  };
}

/** Error as the Gateway client produces it: message plus `details` from the RPC error. */
function apiError(details: Record<string, unknown>): Error {
  return Object.assign(new Error(String(details.message)), { details });
}

type Harness = {
  deps: JobsCliDeps;
  logs: string[];
  errors: string[];
  exit: ReturnType<typeof vi.fn>;
  calls: JobsGatewayRequest[];
};

function harness(respond: (req: JobsGatewayRequest) => Promise<unknown>): Harness {
  const logs: string[] = [];
  const errors: string[] = [];
  const calls: JobsGatewayRequest[] = [];
  const exit = vi.fn() as unknown as ReturnType<typeof vi.fn>;
  const deps: JobsCliDeps = {
    runtime: {
      log: (...a: unknown[]) => void logs.push(a.join(" ")),
      error: (...a: unknown[]) => void errors.push(a.join(" ")),
      exit: exit as unknown as (code: number) => never,
    },
    callGateway: async (req) => {
      calls.push(req);
      return await respond(req);
    },
  };
  return { deps, logs, errors, exit, calls };
}

async function run(h: Harness, ...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerJobsCli(program, h.deps);
  await program.parseAsync(["node", "friday", "jobs", ...args]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("friday jobs: method mapping", () => {
  it.each([
    [
      ["create", "write docs", "--type", "research"],
      "job.create",
      { goal: "write docs", type: "research" },
    ],
    [["list"], "job.list", {}],
    [["list", "--cursor", "abc", "--limit", "5"], "job.list", { cursor: "abc", limit: 5 }],
    [["show", "j1"], "job.show", { jobId: "j1" }],
    [["pause", "j1"], "job.pause", { jobId: "j1" }],
    [["resume", "j1"], "job.resume", { jobId: "j1" }],
    [["cancel", "j1"], "job.cancel", { jobId: "j1" }],
    [["replay", "j1"], "job.replay", { jobId: "j1" }],
    [["digest", "--since", "1000"], "job.digest", { sinceMs: 1000 }],
  ])("%j calls %s", async (args, method, params) => {
    const h = harness(async () => ({
      job: { ...summary("j1"), tasks: [], timeline: [] },
      jobs: [],
      hasMore: false,
      jobId: "j1",
      events: [],
      entries: [],
      text: "",
      generatedAtMs: 0,
    }));
    await run(h, ...args);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.method).toBe(method);
    expect(h.calls[0]?.params).toEqual(params);
    expect(h.calls[0]?.timeoutMs).toBe(JOBS_GATEWAY_TIMEOUT_MS);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.errors).toEqual([]);
  });

  it("create without --type omits it and prints the new id", async () => {
    const h = harness(async () => ({ job: summary("j9", { state: "queued" }) }));
    await run(h, "create", "do it");
    expect(h.calls[0]?.params).toEqual({ goal: "do it" });
    expect(h.logs).toEqual(["Created job j9 (queued)"]);
  });

  it("passes --url and --token to the Gateway caller", async () => {
    const h = harness(async () => ({ job: summary("j1") }));
    await run(h, "pause", "j1", "--url", "ws://x:1", "--token", "t");
    expect(h.calls[0]).toMatchObject({ url: "ws://x:1", token: "t" });
  });
});

describe("friday jobs: output", () => {
  it("list prints rows in server order (newest first) and a next-page hint", async () => {
    const h = harness(async () => ({
      jobs: [summary("new", { createdAtMs: 2000 }), summary("old", { createdAtMs: 1000 })],
      hasMore: true,
      nextCursor: "cur-1",
    }));
    await run(h, "list");
    expect(h.logs[0]).toContain("new");
    expect(h.logs[1]).toContain("old");
    expect(h.logs[2]).toContain("--cursor cur-1");
  });

  it("list prints a message for an empty page", async () => {
    const h = harness(async () => ({ jobs: [], hasMore: false }));
    await run(h, "list");
    expect(h.logs).toEqual(["No jobs."]);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("replay prints one event per line in ascending timestamp order", async () => {
    const ev = (seq: number, createdAtMs: number): JobTraceEvent => ({
      ts: new Date(createdAtMs).toISOString(),
      seq,
      stage: "job:event",
      jobId: "j1",
      type: "t",
      createdAtMs,
      payload: { n: seq },
    });
    const h = harness(async () => ({ jobId: "j1", events: [ev(3, 300), ev(1, 100), ev(2, 200)] }));
    await run(h, "replay", "j1");
    expect(h.logs).toHaveLength(3);
    expect(h.logs.map((l) => /#(\d)/.exec(l)?.[1])).toEqual(["1", "2", "3"]);
    expect(h.logs[0]).toContain('{"n":1}');
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("show prints tasks and timeline", async () => {
    const h = harness(async () => ({
      job: {
        ...summary("j1"),
        tasks: [{ id: "t1", role: "coder", dependsOn: [], state: "running", usage: USAGE }],
        timeline: [{ ts: "2026-01-01T00:00:00.000Z", seq: 1, stage: "job:state", type: "started" }],
      },
    }));
    await run(h, "show", "j1");
    const out = h.logs.join("\n");
    expect(out).toContain("Job:      j1");
    expect(out).toContain("t1 [coder]  running");
    expect(out).toContain("job:state  started");
  });

  it("digest prints the digest text", async () => {
    const h = harness(async () => ({ entries: [], text: "nothing changed", generatedAtMs: 1 }));
    await run(h, "digest");
    expect(h.logs).toEqual(["nothing changed"]);
  });

  it("--json prints the raw result", async () => {
    const h = harness(async () => ({ job: summary("j1") }));
    await run(h, "cancel", "j1", "--json");
    expect(JSON.parse(h.logs.join("\n"))).toMatchObject({ job: { id: "j1" } });
  });
});

describe("friday jobs: errors", () => {
  it("prints a validation error with its field to stderr and exits 1", async () => {
    const h = harness(async () => {
      throw apiError({
        code: "validation",
        message: "goal is required",
        field: "goal",
        fields: ["goal"],
      });
    });
    await run(h, "create", " ");
    expect(h.errors).toEqual(["Error (validation): goal is required", "  field: goal"]);
    expect(h.logs).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("prints not_found with the job id", async () => {
    const h = harness(async () => {
      throw apiError({ code: "not_found", message: "Job not found", jobId: "nope" });
    });
    await run(h, "show", "nope");
    expect(h.errors).toEqual(["Error (not_found): Job not found", "  job: nope"]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("prints the current state for invalid_transition", async () => {
    const h = harness(async () => {
      throw apiError({
        code: "invalid_transition",
        message: "Cannot resume",
        jobId: "j1",
        currentState: "cancelled",
      });
    });
    await run(h, "resume", "j1");
    expect(h.errors.join("\n")).toContain("current state: cancelled");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("prints a plain Gateway failure to stderr and exits 1", async () => {
    const h = harness(async () => {
      throw new Error("gateway closed (1006): no close reason");
    });
    await run(h, "list");
    expect(h.errors).toEqual(["Error: gateway closed (1006): no close reason"]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("rejects an unknown --type before calling the Gateway", async () => {
    const h = harness(async () => ({}));
    await run(h, "create", "x", "--type", "magic");
    expect(h.calls).toEqual([]);
    expect(h.errors[0]).toContain("--type must be one of coding, research, operations");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("rejects a non-numeric --limit before calling the Gateway", async () => {
    const h = harness(async () => ({}));
    await run(h, "list", "--limit", "many");
    expect(h.calls).toEqual([]);
    expect(h.errors[0]).toContain("--limit must be a non-negative integer");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("gives up after 10 seconds with a stderr message and exit 1", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Promise(() => undefined));
    const done = run(h, "list");
    await vi.advanceTimersByTimeAsync(JOBS_GATEWAY_TIMEOUT_MS - 1);
    expect(h.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.errors).toEqual(["Error: Gateway did not respond within 10 seconds."]);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave a timer behind after a successful call", async () => {
    vi.useFakeTimers();
    const h = harness(async () => ({ jobs: [], hasMore: false }));
    await run(h, "list");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("formatJobsError", () => {
  it("lists every invalid field", () => {
    const lines = formatJobsError(
      apiError({ code: "validation", message: "bad", field: "a", fields: ["a", "b"] }),
    );
    expect(lines).toEqual(["Error (validation): bad", "  field: a, b"]);
  });

  it("ignores details that are not a Jobs_API error", () => {
    const err = Object.assign(new Error("boom"), { details: { code: "other", message: "x" } });
    expect(formatJobsError(err)).toEqual(["Error: boom"]);
  });
});

describe("friday jobs health", () => {
  it("reports OK and never calls the Gateway", async () => {
    const h = harness(async () => ({}));
    h.deps.checkHealth = async () => ({ freeDiskBytes: 42 });
    await run(h, "health");
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual(["Health monitor OK (free disk: 42 bytes)"]);
    expect(h.exit).not.toHaveBeenCalled();
  });
  it("prints the error and exits 1 when the check fails", async () => {
    const h = harness(async () => ({}));
    h.deps.checkHealth = async () => {
      throw new Error("probe failed");
    };
    await run(h, "health");
    expect(h.errors).toEqual(["Error: probe failed"]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});
