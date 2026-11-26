import { describe, expect, it } from "vitest";
import { sleepWithClock } from "./deps.js";
import {
  LEASE_HEARTBEAT_INTERVAL_MS,
  MAX_STEP_ATTEMPTS,
  ProxyUnreachableError,
  runStep,
  type AgentTurnRequest,
  type AgentTurnResult,
  type StepRunRequest,
} from "./step-runner.js";
import { EventRecorder, FakeClock, MemoryFs, flushMicrotasks } from "./test-helpers.js";

const PROGRESS = "/job/progress.md";
const BIG = { tokens: 1e9, wallClockMs: 1e9, toolCalls: 1e9 };

function setup() {
  const clock = new FakeClock();
  const fs = new MemoryFs();
  const rec = new EventRecorder();
  const startMs = clock.now();
  const run = (
    runTurn: (r: AgentTurnRequest) => Promise<AgentTurnResult>,
    overrides: Partial<StepRunRequest> = {},
  ) =>
    runStep(
      { runTurn, appendEvent: rec.append, clock, fs },
      {
        jobId: "j1",
        taskId: "t1",
        stepId: "s1",
        progressPath: PROGRESS,
        upstream: [],
        models: ["m1", "m2", "m3"],
        stepBudget: BIG,
        jobBudget: BIG,
        timeoutSeconds: 600,
        ...overrides,
      },
    );
  return { clock, fs, rec, run, startMs };
}

/** A turn that produces no output until it is aborted, then rejects. */
function hangUntilAbort(req: AgentTurnRequest): Promise<AgentTurnResult> {
  return new Promise((_, reject) => {
    req.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

const ok = (reply = "done"): Promise<AgentTurnResult> => Promise.resolve({ reply });
const payload = (e: { payload: unknown }) => e.payload as Record<string, unknown>;

describe("runStep: success path", () => {
  it("passes only progress and upstream results, then updates progress.md and appends the result within 5s", async () => {
    const { clock, fs, rec, run, startMs } = setup();
    fs.files.set(PROGRESS, "# Progress\n\nearlier work");
    const seen: AgentTurnRequest[] = [];
    const upstream = [{ taskId: "t0", result: "r0", transcript: "secret chat" }];

    const result = await clock.drive(
      run(
        async (r) => {
          seen.push(r);
          return {
            reply: "full reply",
            progressNote: "did the thing",
            usage: { inputTokens: 10, outputTokens: 5, toolCalls: 2 },
          };
        },
        { upstream },
      ),
    );

    expect(result).toMatchObject({ status: "completed", model: "m1", attempts: 1 });
    expect(seen[0]?.input).toEqual({
      progress: "# Progress\n\nearlier work",
      upstream: [{ taskId: "t0", result: "r0" }],
    });
    expect(JSON.stringify(seen[0]?.input)).not.toContain("secret chat");

    const progress = fs.files.get(PROGRESS) ?? "";
    expect(progress).toContain("earlier work");
    expect(progress).toContain("did the thing");

    expect(rec.types()).toEqual(["step-started", "step-completed"]);
    const completed = rec.ofType("step-completed")[0]!;
    expect(completed.createdAtMs - startMs).toBeLessThanOrEqual(5000);
    expect(completed.taskId).toBe("t1");
    expect(payload(completed)).toMatchObject({
      result: "full reply",
      usage: { tokens: 15, inputTokens: 10, outputTokens: 5, toolCalls: 2 },
    });
  });

  it("grants a 30s lease on the first step-started event", async () => {
    const { clock, rec, run, startMs } = setup();
    await clock.drive(run(() => ok()));
    expect(payload(rec.ofType("step-started")[0]!).leaseExpiresAtMs).toBe(startMs + 30_000);
  });

  it("renews the lease every heartbeat interval while the turn runs", async () => {
    const { clock, rec, run, startMs } = setup();
    const sleep = sleepWithClock(clock);
    await clock.drive(
      run(async (r) => {
        for (let i = 0; i < 5; i++) {
          await sleep(5_000);
          r.reportActivity();
        }
        return { reply: "ok" };
      }),
    );
    const beats = rec.ofType("lease-heartbeat");
    expect(beats.map((b) => b.createdAtMs - startMs)).toEqual([
      LEASE_HEARTBEAT_INTERVAL_MS,
      2 * LEASE_HEARTBEAT_INTERVAL_MS,
    ]);
    expect(payload(beats[0]!).expiresAtMs).toBe(startMs + LEASE_HEARTBEAT_INTERVAL_MS + 30_000);
  });

  it("still records the result when progress.md cannot be written", async () => {
    const { clock, fs, rec, run } = setup();
    fs.failWrites = new Error("disk full");
    const result = await clock.drive(run(() => ok()));
    expect(result.status).toBe("completed");
    expect(rec.types()).toEqual(["step-started", "progress-write-failed", "step-completed"]);
  });

  it("gives up on a hung progress.md write after 3s so the result lands within 5s", async () => {
    const { clock, fs, rec, run } = setup();
    fs.hangWrites = true;
    const result = await clock.drive(run(() => ok()));
    expect(result.status).toBe("completed");
    const started = rec.ofType("step-started")[0]!;
    const completed = rec.ofType("step-completed")[0]!;
    expect(completed.createdAtMs - started.createdAtMs).toBeLessThanOrEqual(5000);
    expect(rec.types()).toContain("progress-write-failed");
  });

  it("rejects without retrying when the Event_Log write fails", async () => {
    const { clock, rec, run } = setup();
    rec.failOn.add("step-completed");
    await expect(clock.drive(run(() => ok()))).rejects.toThrow("append failed");
  });
});

describe("runStep: budgets (Req 6.3, 6.4)", () => {
  it("fails on a per-Step token limit, names tokens and per-Step, and keeps progress.md", async () => {
    const { clock, fs, rec, run } = setup();
    fs.files.set(PROGRESS, "keep me");
    let aborted = false;
    const result = await clock.drive(
      run(
        async (r) => {
          r.signal.addEventListener("abort", () => (aborted = true));
          r.reportActivity({ outputTokens: 150 });
          return hangUntilAbort(r);
        },
        { stepBudget: { ...BIG, tokens: 100 } },
      ),
    );
    expect(result).toMatchObject({ status: "failed", failure: "budget-exceeded", attempts: 1 });
    expect(result.status === "failed" && result.reason).toContain("tokens");
    expect(result.status === "failed" && result.reason).toContain("per-Step");
    expect(rec.types()).toEqual(["step-started", "budget-exceeded", "step-failed"]);
    expect(payload(rec.ofType("budget-exceeded")[0]!)).toMatchObject({
      exceeded: "tokens",
      scope: "step",
      limit: 100,
    });
    expect(aborted).toBe(true);
    expect(fs.writes).toEqual([]);
    expect(fs.files.get(PROGRESS)).toBe("keep me");
  });

  it("fails on a per-Job tool-call limit using usage from earlier Steps", async () => {
    const { clock, rec, run } = setup();
    const result = await clock.drive(
      run(
        async (r) => {
          r.reportActivity({ toolCalls: 2 });
          return hangUntilAbort(r);
        },
        {
          jobBudget: { ...BIG, toolCalls: 5 },
          jobUsageBefore: { tokens: 0, wallClockMs: 0, toolCalls: 4 },
        },
      ),
    );
    expect(result.status === "failed" && result.reason).toContain("per-Job");
    expect(payload(rec.ofType("budget-exceeded")[0]!)).toMatchObject({
      exceeded: "toolCalls",
      scope: "job",
    });
  });

  it("allows usage exactly equal to the limit", async () => {
    const { clock, run } = setup();
    const result = await clock.drive(
      run(async () => ({ reply: "x", usage: { outputTokens: 100 } }), {
        stepBudget: { ...BIG, tokens: 100 },
      }),
    );
    expect(result.status).toBe("completed");
  });

  it("stops a silent turn within 5s of the wall-clock limit", async () => {
    const { clock, rec, run, startMs } = setup();
    const result = await clock.drive(
      run(hangUntilAbort, { stepBudget: { ...BIG, wallClockMs: 30_000 } }),
    );
    expect(result.status === "failed" && result.failure).toBe("budget-exceeded");
    const exceeded = rec.ofType("budget-exceeded")[0]!;
    expect(payload(exceeded).exceeded).toBe("wallClockMs");
    expect(exceeded.createdAtMs - (startMs + 30_000)).toBeLessThanOrEqual(5000);
  });

  it("does not start a Step when earlier Steps already used the Job Budget", async () => {
    const { clock, rec, run } = setup();
    let called = false;
    const result = await clock.drive(
      run(
        async () => {
          called = true;
          return { reply: "x" };
        },
        {
          jobBudget: { ...BIG, tokens: 10 },
          jobUsageBefore: { tokens: 11, wallClockMs: 0, toolCalls: 0 },
        },
      ),
    );
    expect(called).toBe(false);
    expect(result.status).toBe("failed");
    expect(rec.types()).toEqual(["budget-exceeded", "step-failed"]);
  });
});

describe("runStep: watchdog (Req 6.6)", () => {
  it("cancels a silent Step after 120s, appends a stall event and retries after 2s on the next model", async () => {
    const { clock, rec, run, startMs } = setup();
    const signals: AbortSignal[] = [];
    const result = await clock.drive(
      run((r) => {
        signals.push(r.signal);
        return r.model === "m1" ? hangUntilAbort(r) : ok("recovered");
      }),
    );
    expect(result).toMatchObject({ status: "completed", model: "m2", attempts: 2 });
    expect(signals[0]?.aborted).toBe(true);
    const stall = rec.ofType("stall")[0]!;
    expect(stall.createdAtMs - startMs).toBe(120_000);
    expect(payload(stall)).toMatchObject({ model: "m1", stallTimeoutSeconds: 120 });
    expect(payload(rec.ofType("step-retry")[0]!)).toMatchObject({ delayMs: 2000, nextModel: "m2" });
    const second = rec.ofType("step-started")[1]!;
    expect(second.createdAtMs - startMs).toBe(122_000);
    expect(payload(second).model).toBe("m2");
  });

  it("does not stall while the turn keeps reporting output", async () => {
    const { clock, rec, run } = setup();
    const sleep = sleepWithClock(clock);
    const result = await clock.drive(
      run(async (r) => {
        for (let i = 0; i < 4; i++) {
          await sleep(100_000);
          r.reportActivity();
        }
        return { reply: "slow but alive" };
      }),
    );
    expect(result.status).toBe("completed");
    expect(rec.ofType("stall")).toEqual([]);
  });

  it("honours a custom stall timeout", async () => {
    const { clock, rec, run, startMs } = setup();
    await clock.drive(
      run((r) => (r.model === "m1" ? hangUntilAbort(r) : ok()), { stallTimeoutSeconds: 10 }),
    );
    expect(rec.ofType("stall")[0]!.createdAtMs - startMs).toBe(10_000);
  });
});

describe("runStep: empty replies and model fallback (Req 6.7, 6.9)", () => {
  it("treats a whitespace reply as a failure, records it and retries on the next model", async () => {
    const { clock, rec, run } = setup();
    const result = await clock.drive(run((r) => (r.model === "m1" ? ok(" \n\t") : ok("real"))));
    expect(result).toMatchObject({ status: "completed", model: "m2", reply: "real" });
    expect(payload(rec.ofType("attempt-failed")[0]!)).toMatchObject({
      cause: "empty",
      model: "m1",
    });
  });

  it("fails with 'all models failed' once the fallback list is exhausted", async () => {
    const { clock, rec, run } = setup();
    const result = await clock.drive(
      run(
        async () => {
          throw new Error("boom");
        },
        { models: ["m1", "m2"] },
      ),
    );
    expect(result).toMatchObject({ status: "failed", failure: "all-models-failed", attempts: 2 });
    expect(result.status === "failed" && result.reason).toContain("all models failed");
    expect(result.status === "failed" && result.reason).toContain("boom");
    expect(rec.ofType("step-failed")).toHaveLength(1);
  });

  it("fails with 'all models failed' when no models are configured", async () => {
    const { clock, run } = setup();
    const result = await clock.drive(run(() => ok(), { models: [] }));
    expect(result).toMatchObject({ status: "failed", failure: "all-models-failed", attempts: 0 });
  });
});

describe("runStep: Proxy unreachable (Req 6.8)", () => {
  it("retries the same model with 2s, 4s, 8s, 16s backoff, then fails naming the Proxy", async () => {
    const { clock, rec, run } = setup();
    const models: string[] = [];
    const result = await clock.drive(
      run(async (r) => {
        models.push(r.model);
        throw new ProxyUnreachableError("ECONNREFUSED");
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      failure: "proxy-unreachable",
      attempts: MAX_STEP_ATTEMPTS,
    });
    expect(result.status === "failed" && result.reason).toMatch(/Proxy unreachable/);
    expect(models).toEqual(["m1", "m1", "m1", "m1", "m1"]);
    expect(rec.ofType("step-retry").map((e) => payload(e).delayMs)).toEqual([
      2000, 4000, 8000, 16000,
    ]);
    const failed = rec.ofType("step-failed");
    expect(failed).toHaveLength(1);
    expect(String(payload(failed[0]!).reason)).toMatch(/Proxy unreachable/);
  });

  it("completes when the Proxy comes back before the limit", async () => {
    const { clock, run } = setup();
    let calls = 0;
    const result = await clock.drive(
      run(async () => {
        calls += 1;
        if (calls < 3) throw new ProxyUnreachableError();
        return { reply: "back" };
      }),
    );
    expect(result).toMatchObject({ status: "completed", model: "m1", attempts: 3 });
  });
});

describe("runStep: retry limit (Req 6.10)", () => {
  it("appends step-failed naming the last cause after 5 attempts", async () => {
    const { clock, rec, run } = setup();
    let n = 0;
    const result = await clock.drive(
      run(
        async () => {
          n += 1;
          throw new Error(`failure-${n}`);
        },
        { models: ["a", "b", "c", "d", "e", "f", "g"] },
      ),
    );
    expect(result).toMatchObject({ status: "failed", failure: "retry-limit", attempts: 5 });
    const failed = rec.ofType("step-failed");
    expect(failed).toHaveLength(1);
    expect(String(payload(failed[0]!).reason)).toContain("failure-5");
    expect(rec.ofType("step-started")).toHaveLength(5);
  });
});

describe("runStep: timeoutSeconds (Req 6.11, 6.12)", () => {
  it.each([
    [undefined, "missing"],
    [0, "0"],
    [86_401, "86401"],
    [1.5, "1.5"],
    ["10", '"10"'],
    [Number.NaN, "NaN"],
  ])("appends an event naming the invalid value %s", async (value, named) => {
    const { clock, rec, run } = setup();
    await clock.drive(run(() => ok(), { timeoutSeconds: value }));
    const events = rec.ofType("invalid-timeout");
    expect(events).toHaveLength(1);
    expect(payload(events[0]!)).toMatchObject({ value: named, defaultSeconds: 600 });
    expect(rec.types()[0]).toBe("invalid-timeout");
  });

  it("does not append an invalid-timeout event for a valid value", async () => {
    const { clock, rec, run } = setup();
    await clock.drive(run(() => ok(), { timeoutSeconds: 86_400 }));
    expect(rec.ofType("invalid-timeout")).toEqual([]);
  });

  it("uses 600s when the value is invalid", async () => {
    const { clock, rec, run, startMs } = setup();
    await clock.drive(
      run((r) => (r.model === "m1" ? hangUntilAbort(r) : ok()), {
        timeoutSeconds: -5,
        stallTimeoutSeconds: 1e6,
      }),
    );
    const failed = rec.ofType("attempt-failed")[0]!;
    expect(payload(failed).cause).toBe("timeout");
    expect(failed.createdAtMs - startMs).toBe(600_000);
  });

  it("enforces a valid custom timeout", async () => {
    const { clock, rec, run, startMs } = setup();
    await clock.drive(
      run((r) => (r.model === "m1" ? hangUntilAbort(r) : ok()), {
        timeoutSeconds: 30,
        stallTimeoutSeconds: 1e6,
      }),
    );
    expect(rec.ofType("attempt-failed")[0]!.createdAtMs - startMs).toBe(30_000);
  });
});

describe("runStep: lease loss (Req 5.8)", () => {
  it("stops without a terminal event when the lease expired before a heartbeat", async () => {
    const { clock, rec, run } = setup();
    const running = run(hangUntilAbort, { stallTimeoutSeconds: 1e6 });
    await flushMicrotasks();
    clock.jump(40_000); // The process was frozen past the 30s lease.
    const result = await clock.drive(running);
    expect(result.status).toBe("lease-lost");
    expect(rec.types()).toEqual(["step-started", "lease-lost"]);
  });
});

describe("runStep: cancelSignal", () => {
  it("abandons the running attempt, fails the Step so its Lease is released, and stops the turn", async () => {
    const { clock, rec, run } = setup();
    const controller = new AbortController();
    let turnSignal: AbortSignal | undefined;
    const pending = run(
      (r) => {
        turnSignal = r.signal;
        return hangUntilAbort(r);
      },
      { cancelSignal: controller.signal },
    );
    await flushMicrotasks();
    expect(rec.types()).toContain("step-started");

    controller.abort();
    const result = await clock.drive(pending);

    expect(result).toMatchObject({ status: "cancelled", attempts: 1 });
    expect(turnSignal?.aborted).toBe(true);
    const failed = rec.ofType("step-failed");
    expect(failed).toHaveLength(1);
    expect(payload(failed[0] as { payload: unknown })).toMatchObject({
      reason: "cancelled",
      cause: "cancelled",
    });
    expect(rec.ofType("step-completed")).toHaveLength(0);
    // No heartbeat after the Lease is released.
    const eventsBefore = rec.events.length;
    await clock.advance(LEASE_HEARTBEAT_INTERVAL_MS * 3);
    expect(rec.events).toHaveLength(eventsBefore);
  });

  it("does not start an attempt when already aborted", async () => {
    const { clock, rec, run } = setup();
    let turns = 0;
    const result = await clock.drive(
      run(
        async () => {
          turns += 1;
          return { reply: "x" };
        },
        { cancelSignal: AbortSignal.abort() },
      ),
    );
    expect(result).toMatchObject({ status: "cancelled", attempts: 0 });
    expect(turns).toBe(0);
    expect(rec.ofType("step-started")).toHaveLength(0);
    expect(rec.ofType("step-failed")).toHaveLength(0);
  });
});
