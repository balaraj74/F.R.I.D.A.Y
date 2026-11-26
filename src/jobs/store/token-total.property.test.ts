import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { projectJobState, type AppendedEvent, type JobRecord, type UsageTotals } from "./index.js";

// Feature: friday-design-orchestrator-harness, Property 44: Token total invariant
// Validates: Requirements 10.7, 10.8

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 });

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    elapsedMs: a.elapsedMs + b.elapsedMs,
  };
}

function sumUsage(items: Iterable<UsageTotals>): UsageTotals {
  let acc = zero();
  for (const u of items) acc = add(acc, u);
  return acc;
}

/** Oracle for Req 10.7: only finite, positive numbers count; everything else is 0. */
function counted(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Usage a single step event contributes, computed straight from its raw payload. */
function eventUsage(payload: unknown): UsageTotals {
  const p =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const inputTokens = counted(p.inputTokens);
  const outputTokens = counted(p.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    elapsedMs: counted(p.elapsedMs),
  };
}

// Valid amounts are integers so float summation order cannot cause false mismatches.
const goodAmount = fc.integer({ min: 0, max: 100_000 });
const badAmount = fc.oneof(
  fc.integer({ min: -100_000, max: -1 }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, -0),
  fc.string({ maxLength: 4 }),
  fc.constantFrom(null, undefined, true, false),
  fc.constant({}),
  fc.constant([5]),
);
const amountValue = fc.oneof(
  { weight: 4, arbitrary: goodAmount },
  { weight: 1, arbitrary: badAmount },
);

const optionalAmount = (arb: fc.Arbitrary<unknown>) =>
  fc.option(arb, { nil: undefined }).map((v) => v);

const stepPayload: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 8, arbitrary: usagePayload(optionalAmount(amountValue)) },
  { weight: 1, arbitrary: fc.constantFrom("junk", null, 42, [1, 2]) },
);

function usagePayload(amount: fc.Arbitrary<unknown>): fc.Arbitrary<Record<string, unknown>> {
  return fc
    .record({
      inputTokens: amount,
      outputTokens: amount,
      elapsedMs: amount,
      agentId: fc.option(fc.constantFrom("a1", "a2", "a3", 7, ""), { nil: undefined }),
      taskId: fc.option(fc.constantFrom("t1", "t2", "t3", "t4"), { nil: undefined }),
      reason: fc.option(fc.constant("boom"), { nil: undefined }),
    })
    .map((r) => {
      // Omit undefined keys so "missing" really means missing.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (v !== undefined) out[k] = v;
      return out;
    });
}

type Draft = Omit<AppendedEvent, "id" | "createdAtMs">;

const draftEvent: fc.Arbitrary<Draft> = fc
  .record({
    jobId: fc.constantFrom("j1", "j2"),
    taskId: fc.option(fc.constantFrom("t1", "t2", "t3", "t4"), { nil: undefined }),
    stepId: fc.option(fc.constantFrom("s1", "s2", "s3", "s4", "s5"), { nil: undefined }),
    type: fc.constantFrom(
      "task-created",
      "step-started",
      "step-completed",
      "step-completed",
      "step-failed",
      "step-failed",
      "lease-reclaimed",
      "something-new",
    ),
    payload: stepPayload,
  })
  .map((r) => {
    const out: Draft = { jobId: r.jobId, type: r.type, payload: r.payload };
    if (r.taskId !== undefined) out.taskId = r.taskId;
    if (r.stepId !== undefined) out.stepId = r.stepId;
    return out;
  });

const eventSequence = fc
  .array(draftEvent, { maxLength: 60 })
  .map((drafts) =>
    drafts.map((d, i): AppendedEvent => ({ ...d, id: i + 1, createdAtMs: (i + 1) * 10 })),
  );

// A step event without a stepId names no Step, so the projection ignores it entirely.
const isStepUsageEvent = (e: AppendedEvent) =>
  (e.type === "step-completed" || e.type === "step-failed") && e.stepId !== undefined;

function checkJob(job: JobRecord, events: AppendedEvent[]) {
  // Req 10.8: sum of per-Task totals equals the Job total, on every field.
  expect(sumUsage(Object.values(job.tasks).map((t) => t.usage))).toEqual(job.usage);

  // Per-agent totals reconcile with the Job total, and (with unattributed) with Step usage.
  expect(sumUsage(Object.values(job.agentUsage))).toEqual(job.usage);
  const stepTotal = sumUsage(Object.values(job.steps).map((s) => s.usage));
  expect(add(sumUsage(Object.values(job.agentUsage)), job.unattributedUsage)).toEqual(stepTotal);
  expect(add(job.usage, job.unattributedUsage)).toEqual(stepTotal);

  // Req 10.7: Step totals come from the raw events, with bad values counted as 0.
  const own = events.filter((e) => e.jobId === job.id && isStepUsageEvent(e));
  expect(stepTotal).toEqual(sumUsage(own.map((e) => eventUsage(e.payload))));
  for (const [stepId, step] of Object.entries(job.steps)) {
    const forStep = own.filter((e) => e.stepId === stepId).map((e) => eventUsage(e.payload));
    expect(step.usage).toEqual(sumUsage(forStep));
    expect(step.usage.totalTokens).toBe(step.usage.inputTokens + step.usage.outputTokens);
  }

  // Every figure is a finite, non-negative number.
  for (const u of [
    job.usage,
    job.unattributedUsage,
    ...Object.values(job.tasks).map((t) => t.usage),
  ]) {
    for (const n of Object.values(u)) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  }
}

describe("Property 44: Token total invariant (Req 10.7, 10.8)", () => {
  it("sum of per-Task usage equals the Job total, and agent totals reconcile with Step usage", () => {
    fc.assert(
      fc.property(eventSequence, (events) => {
        const { jobs } = projectJobState(events);
        for (const job of Object.values(jobs)) checkJob(job, events);
      }),
      { numRuns: 200 },
    );
  });

  it("holds regardless of the order the events are supplied in", () => {
    fc.assert(
      fc.property(eventSequence, fc.infiniteStream(fc.nat()), (events, rnd) => {
        const shuffled = [...events];
        const it = rnd[Symbol.iterator]();
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = it.next().value % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const a = projectJobState(events);
        const b = projectJobState(shuffled);
        expect(b).toEqual(a);
        for (const job of Object.values(b.jobs)) checkJob(job, events);
      }),
      { numRuns: 100 },
    );
  });

  it("counts negative, NaN, non-numeric and missing values as 0", () => {
    const allBad = usagePayload(optionalAmount(badAmount));
    fc.assert(
      fc.property(fc.array(allBad, { minLength: 1, maxLength: 20 }), (payloads) => {
        const events = payloads.map(
          (payload, i): AppendedEvent => ({
            id: i + 1,
            jobId: "j",
            taskId: "t",
            stepId: `s${i % 3}`,
            type: i % 2 === 0 ? "step-completed" : "step-failed",
            payload,
            createdAtMs: i,
          }),
        );
        const job = projectJobState(events).jobs.j!;
        expect(job.usage).toEqual(zero());
        expect(job.unattributedUsage).toEqual(zero());
        for (const t of Object.values(job.tasks)) expect(t.usage).toEqual(zero());
        for (const s of Object.values(job.steps)) expect(s.usage).toEqual(zero());
      }),
      { numRuns: 100 },
    );
  });

  it("accumulates repeated attempts of the same Step into Step, Task and Job totals", () => {
    const attempt = fc.record({
      inputTokens: goodAmount,
      outputTokens: goodAmount,
      elapsedMs: goodAmount,
      failed: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(attempt, { minLength: 1, maxLength: 15 }), (attempts) => {
        const events: AppendedEvent[] = [];
        for (const a of attempts) {
          const base = { jobId: "j", taskId: "t", stepId: "s", createdAtMs: events.length };
          events.push({ ...base, id: events.length + 1, type: "step-started", payload: {} });
          events.push({
            ...base,
            id: events.length + 1,
            type: a.failed ? "step-failed" : "step-completed",
            payload: {
              inputTokens: a.inputTokens,
              outputTokens: a.outputTokens,
              elapsedMs: a.elapsedMs,
            },
          });
        }
        const expected = sumUsage(
          attempts.map((a) => ({
            inputTokens: a.inputTokens,
            outputTokens: a.outputTokens,
            totalTokens: a.inputTokens + a.outputTokens,
            elapsedMs: a.elapsedMs,
          })),
        );
        const job = projectJobState(events).jobs.j!;
        expect(job.steps.s!.attempt).toBe(attempts.length);
        expect(job.steps.s!.usage).toEqual(expected);
        expect(job.tasks.t!.usage).toEqual(expected);
        expect(job.usage).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});
