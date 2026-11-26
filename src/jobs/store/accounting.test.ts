import { describe, expect, it } from "vitest";
import {
  projectJobState,
  UNKNOWN_AGENT,
  type AppendedEvent,
  type JobRecord,
  type UsageTotals,
} from "./index.js";

let nextId = 1;
function ev(
  partial: Omit<AppendedEvent, "id" | "createdAtMs" | "payload"> & { payload?: unknown },
) {
  const id = nextId++;
  return { payload: {}, createdAtMs: id * 10, ...partial, id } as AppendedEvent;
}

const sum = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  elapsedMs: a.elapsedMs + b.elapsedMs,
});
const zero: UsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 };

function job(events: AppendedEvent[]): JobRecord {
  return projectJobState(events).jobs.j!;
}

describe("per-Step accounting (Req 10.7, 10.8)", () => {
  it("records tokens and elapsed ms per Step, Task, agent and Job", () => {
    const j = job([
      ev({ jobId: "j", taskId: "t1", type: "task-created" }),
      ev({ jobId: "j", taskId: "t2", type: "task-created" }),
      ev({
        jobId: "j",
        taskId: "t1",
        stepId: "s1",
        type: "step-completed",
        payload: { inputTokens: 10, outputTokens: 5, elapsedMs: 100, agentId: "a1" },
      }),
      ev({
        jobId: "j",
        taskId: "t1",
        stepId: "s2",
        type: "step-failed",
        payload: { inputTokens: 1, outputTokens: 2, elapsedMs: 7, agentId: "a2", reason: "x" },
      }),
      ev({
        jobId: "j",
        taskId: "t2",
        stepId: "s3",
        type: "step-completed",
        payload: { inputTokens: 4, outputTokens: 4, elapsedMs: 50, agentId: "a1" },
      }),
    ]);
    expect(j.steps.s1!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      elapsedMs: 100,
    });
    expect(j.steps.s1!.agentId).toBe("a1");
    expect(j.steps.s2!.status).toBe("failed");
    expect(j.tasks.t1!.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      elapsedMs: 107,
    });
    expect(j.tasks.t2!.usage.totalTokens).toBe(8);
    expect(j.usage).toEqual({ inputTokens: 15, outputTokens: 11, totalTokens: 26, elapsedMs: 157 });
    expect(j.agentUsage.a1!.totalTokens).toBe(23);
    expect(j.agentUsage.a2!.totalTokens).toBe(3);
    expect(sum(j.tasks.t1!.usage, j.tasks.t2!.usage)).toEqual(j.usage);
  });

  it("treats missing, non-numeric and negative values as 0", () => {
    const j = job([
      ev({ jobId: "j", taskId: "t", type: "task-created" }),
      ev({ jobId: "j", taskId: "t", stepId: "a", type: "step-completed" }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "b",
        type: "step-completed",
        payload: { inputTokens: "9", outputTokens: -3, elapsedMs: Number.NaN },
      }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "c",
        type: "step-completed",
        payload: { inputTokens: 3, outputTokens: null, elapsedMs: Infinity },
      }),
      ev({ jobId: "j", taskId: "t", stepId: "d", type: "step-completed", payload: "junk" }),
    ]);
    expect(j.usage).toEqual({ inputTokens: 3, outputTokens: 0, totalTokens: 3, elapsedMs: 0 });
    expect(j.steps.a!.usage).toEqual(zero);
    expect(j.steps.b!.usage).toEqual(zero);
  });

  it("sums repeated attempts of the same Step", () => {
    const j = job([
      ev({ jobId: "j", taskId: "t", type: "task-created" }),
      ev({ jobId: "j", taskId: "t", stepId: "s", type: "step-started" }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "s",
        type: "step-failed",
        payload: { inputTokens: 2, outputTokens: 1, elapsedMs: 5 },
      }),
      ev({ jobId: "j", taskId: "t", stepId: "s", type: "step-started" }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "s",
        type: "step-completed",
        payload: { inputTokens: 3, outputTokens: 1, elapsedMs: 6 },
      }),
    ]);
    expect(j.steps.s!.usage.totalTokens).toBe(7);
    expect(j.usage).toEqual(j.tasks.t!.usage);
  });

  it("resolves the Task from the payload or the started Step, and the agent from step-started", () => {
    const j = job([
      ev({
        jobId: "j",
        taskId: "t1",
        stepId: "s1",
        type: "step-started",
        payload: { agentId: "a" },
      }),
      ev({
        jobId: "j",
        stepId: "s1",
        type: "step-completed",
        payload: { inputTokens: 2, outputTokens: 0, elapsedMs: 1 },
      }),
      ev({
        jobId: "j",
        stepId: "s2",
        type: "step-completed",
        payload: { inputTokens: 5, outputTokens: 0, elapsedMs: 1, taskId: "t2" },
      }),
    ]);
    expect(j.tasks.t1!.usage.inputTokens).toBe(2);
    expect(j.tasks.t2!.usage.inputTokens).toBe(5);
    expect(j.agentUsage.a!.inputTokens).toBe(2);
    expect(j.agentUsage[UNKNOWN_AGENT]!.inputTokens).toBe(5);
    expect(sum(j.tasks.t1!.usage, j.tasks.t2!.usage)).toEqual(j.usage);
  });

  it("keeps Step events with no Task out of the Job total so the invariant holds", () => {
    const j = job([
      ev({ jobId: "j", taskId: "t", type: "task-created" }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "s1",
        type: "step-completed",
        payload: { inputTokens: 1, outputTokens: 1, elapsedMs: 1 },
      }),
      ev({
        jobId: "j",
        stepId: "orphan",
        type: "step-completed",
        payload: { inputTokens: 8, outputTokens: 8, elapsedMs: 8 },
      }),
    ]);
    expect(j.usage.totalTokens).toBe(2);
    expect(j.unattributedUsage.totalTokens).toBe(16);
    expect(sum(zero, j.tasks.t!.usage)).toEqual(j.usage);
  });

  it("does not create Tasks for zero-valued events and accounts per Job", () => {
    const projection = projectJobState([
      ev({ jobId: "j", taskId: "ghost", stepId: "s", type: "step-completed" }),
      ev({
        jobId: "k",
        taskId: "t",
        stepId: "s",
        type: "step-completed",
        payload: { inputTokens: 1, outputTokens: 0, elapsedMs: 0 },
      }),
    ]);
    expect(projection.jobs.j!.tasks).toEqual({});
    expect(projection.jobs.j!.usage).toEqual(zero);
    expect(projection.jobs.k!.usage.totalTokens).toBe(1);
  });

  it("is independent of input order and does not mutate its input", () => {
    const events = [
      ev({ jobId: "j", taskId: "t", type: "task-created" }),
      ev({
        jobId: "j",
        taskId: "t",
        stepId: "s",
        type: "step-completed",
        payload: { inputTokens: 4, outputTokens: 6, elapsedMs: 9, agentId: "a" },
      }),
    ];
    const copy = structuredClone(events);
    const once = projectJobState(events);
    expect(projectJobState([...events].reverse())).toEqual(once);
    expect(events).toEqual(copy);
  });
});
