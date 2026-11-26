// Feature: friday-design-orchestrator-harness, Property 47: Invalid or impossible API requests never mutate state
//
// Validates: Requirements 11.5, 11.6, 11.7
//
// Every request below is rejected, and the test checks two things for each: the error
// variant and fields are the documented ones, and neither the Event_Log nor the mutating
// deps (createJob, pause, resume, cancel) were touched.
import { Value } from "@sinclair/typebox/value";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ALLOWED_TRANSITIONS, requestTransition } from "../../jobs/engine/state-machine.js";
import { appendEvent, EVENT_TYPES, loadEvents, openEventLog } from "../../jobs/store/index.js";
import type { JobState } from "../../jobs/store/types.js";
import {
  cancelJob,
  createJob,
  JobsApiErrorSchema,
  pauseJob,
  replayJob,
  resumeJob,
  showJob,
  type JobsApiDeps,
  type JobsApiResult,
} from "./jobs.js";

type Harness = {
  deps: JobsApiDeps;
  calls: { createJob: number; pause: number; resume: number; cancel: number };
  /** Jobs seeded into the log, with the state each was driven to. */
  seeded: Array<{ id: string; state: JobState }>;
  snapshot: () => string;
};

/**
 * In-memory Event_Log with one Job per walk. A walk picks successive allowed transitions
 * (index modulo the options), so seeded Jobs reach every state through legal moves only.
 * An `ops:health` owner is added too: it has events but is not a Job.
 */
function harness(walks: number[][]): Harness {
  const db = openEventLog(":memory:");
  let clock = 1_000;
  const tick = () => (clock += 10);
  const calls = { createJob: 0, pause: 0, resume: 0, cancel: 0 };
  const seeded: Harness["seeded"] = [];
  walks.forEach((walk, i) => {
    const id = `job-${i + 1}`;
    appendEvent(db, {
      jobId: id,
      type: EVENT_TYPES.jobCreated,
      payload: { goal: `goal ${i}` },
      createdAtMs: tick(),
    });
    let state: JobState = "pending";
    for (const pick of walk) {
      const options = ALLOWED_TRANSITIONS[state];
      if (options.length === 0) break;
      const to = options[pick % options.length] as JobState;
      const res = requestTransition(db, id, to, { nowMs: tick() });
      if (!res.ok) throw new Error(`seed transition ${state} -> ${to} failed`);
      state = to;
    }
    seeded.push({ id, state });
  });
  appendEvent(db, { jobId: "ops:health", type: "disk-low", payload: {}, createdAtMs: tick() });

  const deps: JobsApiDeps = {
    db,
    createJob: async (input) => {
      calls.createJob += 1;
      const id = `new-${calls.createJob}`;
      appendEvent(db, {
        jobId: id,
        type: EVENT_TYPES.jobCreated,
        payload: { goal: input.goal },
        createdAtMs: tick(),
      });
      return { id };
    },
    pause: (id) => {
      calls.pause += 1;
      void requestTransition(db, id, "paused");
    },
    resume: (id) => {
      calls.resume += 1;
      void requestTransition(db, id, "running");
    },
    cancel: (id) => {
      calls.cancel += 1;
      void requestTransition(db, id, "cancelled");
    },
    now: () => clock,
  };
  return { deps, calls, seeded, snapshot: () => JSON.stringify(loadEvents(db)) };
}

const walksArb = fc.array(fc.array(fc.nat(10), { maxLength: 6 }), { maxLength: 4 });

const CONTROLS = { pause: pauseJob, resume: resumeJob, cancel: cancelJob } as const;
type ControlKind = keyof typeof CONTROLS;
const ID_METHODS = {
  show: showJob,
  replay: replayJob,
  pause: pauseJob,
  resume: resumeJob,
  cancel: cancelJob,
} as const;
type IdMethod = keyof typeof ID_METHODS;
const idMethodArb = fc.constantFrom(...(Object.keys(ID_METHODS) as IdMethod[]));

/** Spec rule, written independently of `canTransition`: which controls a state rejects. */
function impossibleControls(state: JobState): ControlKind[] {
  const terminal = state === "done" || state === "failed" || state === "cancelled";
  const out: ControlKind[] = [];
  if (state !== "running") out.push("pause"); // only running -> paused exists
  if (state !== "paused") out.push("resume"); // waiting_approval -> running is approval, not resume
  if (terminal) out.push("cancel");
  return out;
}

function expectRejectedWithoutMutation(
  h: Harness,
  before: string,
  res: JobsApiResult<unknown>,
): void {
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(Value.Check(JobsApiErrorSchema, res.error)).toBe(true);
  // Event_Log is identical row for row, and no mutating dep ran.
  expect(h.snapshot()).toBe(before);
  expect(h.calls).toEqual({ createJob: 0, pause: 0, resume: 0, cancel: 0 });
}

// --- Generators for malformed params -------------------------------------------------

const KNOWN_KEYS = new Set(["goal", "type", "concurrencyLimit", "jobId"]);
const extraKeysArb = fc
  .uniqueArray(
    fc.stringMatching(/^[a-z]{1,8}$/).filter((k) => !KNOWN_KEYS.has(k)),
    { maxLength: 3 },
  )
  .map((keys) => Object.fromEntries(keys.map((k) => [k, 1])));

type Field = { present: boolean; value?: unknown; valid: boolean };
const field = (valid: fc.Arbitrary<unknown>, invalid: fc.Arbitrary<unknown>): fc.Arbitrary<Field> =>
  fc.oneof(
    valid.map((value): Field => ({ present: true, value, valid: true })),
    invalid.map((value): Field => ({ present: true, value, valid: false })),
    fc.constant<Field>({ present: false, valid: true }),
  );

// `goal` is required, so an absent goal is itself invalid.
const goalField = field(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /\S/.test(s)),
  fc.constantFrom("", "   ", "\n\t", 5, null, true, {}, [], "x".repeat(20_001)),
).map((f): Field => (f.present ? f : { present: false, valid: false }));
const typeField = field(
  fc.constantFrom("coding", "research", "operations"),
  fc.constantFrom("", "other", 3, null, {}),
);
const limitField = field(
  fc.integer({ min: 1, max: 16 }),
  fc.constantFrom(0, 17, -3, 1.5, "4", null, 1e9),
);

/** createJob params with at least one invalid field; `expected` lists those fields. */
const badCreateParams = fc
  .tuple(goalField, typeField, limitField, extraKeysArb)
  .map(([goal, type, limit, extras]) => {
    const params: Record<string, unknown> = { ...extras };
    const expected = Object.keys(extras);
    const named: Array<[string, Field]> = [
      ["goal", goal],
      ["type", type],
      ["concurrencyLimit", limit],
    ];
    for (const [name, f] of named) {
      if (f.present) params[name] = f.value;
      if (!f.valid) expected.push(name);
    }
    return { params, expected };
  })
  .filter(({ expected }) => expected.length > 0);

const notAnObject = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer()),
);

const badJobId = fc.constantFrom("", "x".repeat(257), 7, null, true, {}, ["a"]);
/** Id-method params that fail validation, with the fields the error must name. */
const badIdParams = fc.oneof(
  notAnObject.map((params) => ({ params, expected: ["params"] })),
  extraKeysArb.map((extras) => ({ params: extras, expected: ["jobId", ...Object.keys(extras)] })),
  fc.tuple(badJobId, extraKeysArb).map(([jobId, extras]) => ({
    params: { ...extras, jobId },
    expected: ["jobId", ...Object.keys(extras)],
  })),
  // A valid jobId with unknown extra keys still fails validation, before any lookup.
  fc
    .tuple(fc.string({ minLength: 1, maxLength: 20 }), extraKeysArb)
    .filter(([, extras]) => Object.keys(extras).length > 0)
    .map(([jobId, extras]) => ({
      params: { ...extras, jobId },
      expected: Object.keys(extras),
    })),
);

function expectValidationNaming(res: JobsApiResult<unknown>, expected: string[]): void {
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.error.code).toBe("validation");
  expect(res.error.fields).toEqual(expect.arrayContaining(expected));
  expect(res.error.fields).toContain(res.error.field);
  for (const name of expected) expect(res.error.message).toContain(name);
}

describe("Property 47: invalid or impossible API requests never mutate state", () => {
  it("rejects malformed createJob params with a validation error naming every invalid field", async () => {
    await fc.assert(
      fc.asyncProperty(walksArb, badCreateParams, async (walks, { params, expected }) => {
        const h = harness(walks);
        const before = h.snapshot();
        const res = await createJob(h.deps, params);
        expectValidationNaming(res, expected);
        expectRejectedWithoutMutation(h, before, res);
      }),
    );
  });

  it("rejects non-object createJob params as a validation error", async () => {
    await fc.assert(
      fc.asyncProperty(walksArb, notAnObject, async (walks, params) => {
        const h = harness(walks);
        const before = h.snapshot();
        const res = await createJob(h.deps, params);
        expectValidationNaming(res, ["params"]);
        expectRejectedWithoutMutation(h, before, res);
      }),
    );
  });

  it("rejects malformed job-id params on every id method with a validation error", async () => {
    await fc.assert(
      fc.asyncProperty(walksArb, idMethodArb, badIdParams, async (walks, method, bad) => {
        const h = harness(walks);
        const before = h.snapshot();
        const res = await ID_METHODS[method](h.deps, bad.params);
        expectValidationNaming(res, bad.expected);
        expectRejectedWithoutMutation(h, before, res);
      }),
    );
  });

  it("returns not_found with the requested jobId for ids that are not Jobs", async () => {
    // "ops:health" owns events but is not a Job; "job-0" and long ids are never seeded.
    const unknownId = fc.oneof(
      fc.string({ minLength: 1, maxLength: 60 }),
      fc.constantFrom("ops:health", "job-0", "job-99", " "),
    );
    await fc.assert(
      fc.asyncProperty(walksArb, idMethodArb, unknownId, async (walks, method, jobId) => {
        const h = harness(walks);
        fc.pre(!h.seeded.some((s) => s.id === jobId));
        const before = h.snapshot();
        const res = await ID_METHODS[method](h.deps, { jobId });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error.code).toBe("not_found");
        expect(res.error.jobId).toBe(jobId);
        expectRejectedWithoutMutation(h, before, res);
      }),
    );
  });

  it("returns invalid_transition with the current state for impossible pause/resume/cancel", async () => {
    // Pick a seeded Job, then a control that its current state rejects.
    const scenario = fc
      .tuple(
        fc.array(fc.array(fc.nat(10), { maxLength: 6 }), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.nat(),
      )
      .map(([walks, jobPick, kindPick]) => ({ walks, jobPick, kindPick }));
    await fc.assert(
      fc.asyncProperty(scenario, async ({ walks, jobPick, kindPick }) => {
        const h = harness(walks);
        const target = h.seeded[jobPick % h.seeded.length];
        if (!target) throw new Error("no seeded job");
        const kinds = impossibleControls(target.state);
        const kind = kinds[kindPick % kinds.length] as ControlKind;
        const before = h.snapshot();
        const res = await CONTROLS[kind](h.deps, { jobId: target.id });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error.code).toBe("invalid_transition");
        expect(res.error.jobId).toBe(target.id);
        expect(res.error.currentState).toBe(target.state);
        expectRejectedWithoutMutation(h, before, res);
      }),
    );
  });
});
