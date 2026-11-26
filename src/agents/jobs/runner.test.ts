import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobRunner, parsePlan, parseStepReply } from "./runner.js";
import { type Job, loadJob, newJob, saveJob } from "./store.js";

let state: string;
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

/** Replies chosen by what the prompt asks for. */
function fakeModel(
  overrides: { step?: (prompt: string, n: number) => string; verify?: string[] } = {},
) {
  let steps = 0;
  const verifies = [...(overrides.verify ?? ["VERIFIED: Report saved as report.md."])];
  return vi.fn(async (_session: string, prompt: string) => {
    if (prompt.includes("Reply ONLY with JSON"))
      return 'Sure! ```json\n{"steps": ["Research", "Write report"]}\n```';
    if (prompt.includes("Check the result")) return verifies.shift() ?? "VERIFIED: ok";
    steps += 1;
    return overrides.step?.(prompt, steps) ?? `DONE: did step ${steps}`;
  });
}

function start(runTurn: ReturnType<typeof fakeModel>) {
  const notify = vi.fn(async () => {});
  const seen: Job[] = [];
  const runner = new JobRunner({
    runTurn,
    notify,
    broadcast: (j) => seen.push(structuredClone(j)),
    stateDir: state,
  });
  const job = saveJob(
    newJob({ title: "Lab report", goal: "Write the DBMS lab report", workspaceDir: state }),
    state,
  );
  return { runner, notify, seen, job };
}

const settle = async (id: string, status: Job["status"][]) => {
  for (let i = 0; i < 200; i++) {
    const job = loadJob(id, state);
    if (job && status.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job never reached ${status.join("/")}`);
};

describe("job runner", () => {
  it("plans, works every step, verifies and tells Sir", async () => {
    const model = fakeModel();
    const { runner, notify, seen, job } = start(model);
    runner.kick();
    const done = await settle(job.id, ["done"]);
    expect(done.steps.map((s) => [s.title, s.status, s.summary])).toEqual([
      ["Research", "done", "did step 1"],
      ["Write report", "done", "did step 2"],
    ]);
    expect(done.report).toBe("Report saved as report.md.");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Done, Sir: "Lab report"'));
    expect(seen.some((j) => j.steps[0]?.status === "running")).toBe(true);
    // Later steps see earlier results, and every turn runs in the job's own session.
    expect(model.mock.calls[2][1]).toContain("1. Research: did step 1");
    expect(new Set(model.mock.calls.map((c) => c[0]))).toEqual(
      new Set([`agent:main:job:${job.id}`]),
    );
    expect(fs.existsSync(done.dir)).toBe(true);
  });

  it("pauses for Sir and resumes with his answer", async () => {
    const { runner, notify, job } = start(
      fakeModel({
        step: (p, n) =>
          n === 1
            ? "NEED SIR: Which lab, 3 or 4?"
            : p.includes("-> Lab 4")
              ? "DONE: used lab 4"
              : "DONE: x",
      }),
    );
    runner.kick();
    const waiting = await settle(job.id, ["waiting"]);
    expect(waiting.question).toBe("Which lab, 3 or 4?");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("needs you, Sir: Which lab, 3 or 4?"),
    );
    waiting.answers.push(`${waiting.question} -> Lab 4`);
    waiting.status = "running";
    saveJob(waiting, state);
    runner.kick();
    const done = await settle(job.id, ["done"]);
    expect(done.steps[0]).toMatchObject({ status: "done", summary: "used lab 4", attempts: 1 });
  });

  it("redoes a step left running by a restart, retries once, then fails", async () => {
    const half = saveJob(
      {
        ...newJob({ title: "T", goal: "G", workspaceDir: state }),
        status: "running",
        steps: [{ title: "Only step", status: "running", attempts: 1 }],
      },
      state,
    );
    const runner = new JobRunner({
      runTurn: vi.fn(async () => ""),
      notify: vi.fn(async () => {}),
      broadcast: () => {},
      stateDir: state,
    });
    runner.kick();
    const failed = await settle(half.id, ["failed"]);
    expect(failed.steps[0]).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("adds one fix round when the check finds problems, then reports what's left", async () => {
    const { runner, job } = start(
      fakeModel({ verify: ["ISSUES: no conclusion", "ISSUES: still thin"] }),
    );
    runner.kick();
    const done = await settle(job.id, ["done"]);
    expect(done.steps.at(-1)?.title).toContain("Fix what the check found: no conclusion");
    expect(done.fixRounds).toBe(1);
    expect(done.report).toContain("still thin");
  });

  it("stops when cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = fakeModel({ step: () => "DONE: x" });
    model.mockImplementationOnce(async () => {
      await gate;
      return '{"steps": ["A", "B"]}';
    });
    const { runner, job } = start(model);
    runner.kick();
    saveJob({ ...loadJob(job.id, state)!, status: "cancelled" }, state);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(loadJob(job.id, state)?.status).toBe("cancelled");
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("reply parsing", () => {
  it("reads plans and step replies", () => {
    expect(parsePlan("no json")).toEqual([]);
    expect(parsePlan('{"steps": [" a ", "", "b"]}')).toEqual(["a", "b"]);
    expect(parseStepReply("blah\nDONE: saved notes.md")).toEqual({ summary: "saved notes.md" });
    expect(parseStepReply("NEED SIR: which format?")).toEqual({
      needSir: "which format?",
      summary: "",
    });
  });
});
