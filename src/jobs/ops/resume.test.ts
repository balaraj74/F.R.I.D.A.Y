// resumeAfterBoot (Requirement 13.10). "Process A" runs a Job and is abandoned mid-flight, which is
// what a reboot looks like to the Event_Log. "Process B" is a new Orchestrator over the same log.
import { describe, expect, it, vi } from "vitest";

import { RESUME_WINDOW_MS, resetJobEngineRestoreForTests } from "../engine/boot.js";
import { flushMicrotasks } from "../runner/test-helpers.js";
import { appendEvent, EVENT_TYPES } from "../store/index.js";
import { listInterruptedJobIds, resumeAfterBoot } from "./resume.js";
import { createRig, never, rawTask } from "./test-helpers.js";

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flushMicrotasks();
  expect(cond()).toBe(true);
}

describe("resumeAfterBoot", () => {
  it("continues from the first incomplete Step and never re-runs completed Steps", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const plan = {
      tasks: [rawTask("a", [], { estimatedReplyTokens: 150_000 }), rawTask("b", ["a"])],
    };
    const a = rig.boot();
    // Step a.1.2 never finishes: the machine reboots while it is running.
    a.agents.turn = async (req) =>
      req.stepId === "a.1.2" ? never() : { reply: `r:${req.stepId}` };
    const { id } = await a.orchestrator.createJob({ goal: "ship", initialPlan: plan });
    await until(() => a.agents.stepIds().includes("a.1.2"));
    expect(rig.ofType(id, "step-completed").map((e) => e.stepId)).toEqual(["a.1.1"]);

    // Reboot. The old Lease (30s) has not expired yet.
    rig.clock.jump(5_000);
    const b = rig.boot();
    const bootTimeMs = rig.clock.now();
    const res = await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock, bootTimeMs }),
    );
    expect(res.adopted).toHaveLength(1);
    expect(res.adopted[0]).toMatchObject({
      jobId: id,
      replanned: false,
      resumedTaskIds: ["a", "b"],
      completedStepIds: ["a.1.1"],
    });
    expect(res.withinDeadline).toBe(true);
    expect(res.completedAtMs - bootTimeMs).toBeLessThanOrEqual(RESUME_WINDOW_MS);

    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
    // a.1.1 is not run again; the rest runs once each.
    expect(b.agents.stepIds()).toEqual(["a.1.2", "a.1.3", "b.1.1"]);
    const bTurn = b.agents.turns.find((t) => t.stepId === "b.1.1");
    expect(bTurn?.input.upstream).toEqual([{ taskId: "a", result: "result of a" }]);
    // The orphaned Lease was released and the takeover is in the log.
    expect(rig.ofType(id, "lease-reclaimed").map((e) => e.stepId)).toEqual(["a.1.2"]);
    expect(rig.ofType(id, "job-adopted")).toHaveLength(1);
    expect(rig.ofType(id, "step-completed").filter((e) => e.stepId === "a.1.1")).toHaveLength(1);
  });

  it("hands a Task that finished before the reboot to its dependents as upstream output", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot();
    a.agents.turn = async (req) => (req.task.id === "b" ? never() : { reply: `r:${req.stepId}` });
    const { id } = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a"), rawTask("b", ["a"])] },
    });
    await until(() => a.agents.stepIds().includes("b.1.1"));

    const b = rig.boot();
    await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock }),
    );
    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
    expect(b.agents.stepIds()).toEqual(["b.1.1"]);
    expect(b.agents.turns[0]?.input.upstream).toEqual([{ taskId: "a", result: "r:a.1.1" }]);
    // Task a already finished, so it only appears once in the log.
    expect(rig.ofType(id, "step-started").filter((e) => e.taskId === "a")).toHaveLength(1);
  });

  it("re-verifies a Task whose Steps were all done when the machine rebooted, without re-running them", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot({ collectEvidence: () => never() });
    const { id } = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await until(() => rig.ofType(id, "verification-started").length === 1);

    const b = rig.boot();
    await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock }),
    );
    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
    expect(b.agents.turns).toHaveLength(0);
    expect(view.tasks[0]?.verificationAttempts).toBe(1);
    expect(rig.ofType(id, "step-completed")).toHaveLength(1);
  });

  it("restarts a Task in the verification round it was in, not from round 1", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    // Round 1 fails verification, so the Task goes back to running as round 2.
    const a = rig.boot({
      collectEvidence: async () => ({ type: "file_exists", exists: false }),
    });
    a.agents.turn = async (req) => (req.round === 2 ? never() : { reply: "first try" });
    const { id } = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await until(() => a.agents.turns.some((t) => t.round === 2));

    const b = rig.boot();
    await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock }),
    );
    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
    expect(b.agents.stepIds()).toEqual(["a.2.1"]);
    // The failed first attempt still counts: this was the second verification.
    expect(view.tasks[0]?.verificationAttempts).toBe(2);
  });

  it("plans again when the reboot came before a plan was saved", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot({ planner: () => never() });
    const { id } = await a.orchestrator.createJob({ goal: "g" });
    await until(() => rig.ofType(id, "job-state-changed").length === 1);

    const planner = vi.fn(async () => ({ tasks: [rawTask("a")] }));
    const b = rig.boot({ planner });
    const res = await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock }),
    );
    expect(res.adopted[0]?.replanned).toBe(true);
    const view = await rig.clock.drive(b.orchestrator.awaitTerminal(id));
    expect(view.state).toBe("done");
    expect(planner).toHaveBeenCalledTimes(1);
  });

  it("leaves finished, paused and health-log entries alone", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot();
    const finished = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await rig.clock.drive(a.orchestrator.awaitTerminal(finished.id));

    const held = rig.boot();
    held.agents.turn = () => never();
    const paused = await held.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await until(() => held.agents.turns.length === 1);
    held.orchestrator.pauseJob(paused.id);
    appendEvent(rig.db, { jobId: "ops:health", type: "health.proxy.restarted", payload: {} });

    expect(listInterruptedJobIds(rig.db)).toEqual([]);
    const b = rig.boot();
    const res = await rig.clock.drive(
      resumeAfterBoot({ db: rig.db, orchestrator: b.orchestrator, clock: rig.clock }),
    );
    expect(res.adopted).toEqual([]);
    expect(b.agents.turns).toHaveLength(0);
  });

  it("refuses to adopt a Job that is already running in this process", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot();
    a.agents.turn = () => never();
    const { id } = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await until(() => a.agents.turns.length === 1);
    const again = await a.orchestrator.adoptJob(id);
    expect(again).toMatchObject({ ok: false, error: "already-active" });
    expect(await a.orchestrator.adoptJob("job-unknown")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });

  it("fails a Job whose plan was only partly saved", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const jobId = "job-partial";
    const at = rig.clock.now();
    appendEvent(rig.db, {
      jobId,
      type: EVENT_TYPES.jobCreated,
      payload: { goal: "g" },
      createdAtMs: at,
    });
    appendEvent(rig.db, {
      jobId,
      type: EVENT_TYPES.jobStateChanged,
      payload: { to: "running" },
      createdAtMs: at,
    });
    appendEvent(rig.db, {
      jobId,
      type: "plan-accepted",
      payload: { attempt: 1, taskCount: 2 },
      createdAtMs: at,
    });
    appendEvent(rig.db, {
      jobId,
      taskId: "a",
      type: EVENT_TYPES.taskCreated,
      payload: { role: "builder", dependsOn: [], acceptanceChecks: [], steps: [] },
      createdAtMs: at,
    });
    const b = rig.boot();
    const res = await resumeAfterBoot({
      db: rig.db,
      orchestrator: b.orchestrator,
      clock: rig.clock,
    });
    expect(res.skipped).toHaveLength(1);
    expect(b.orchestrator.getJob(jobId)?.state).toBe("failed");
    expect(b.agents.turns).toHaveLength(0);
  });

  it("reports a missed 60s deadline and notifies when a Job cannot be taken over", async () => {
    resetJobEngineRestoreForTests();
    const rig = createRig();
    const a = rig.boot();
    a.agents.turn = () => never();
    const { id } = await a.orchestrator.createJob({
      goal: "g",
      initialPlan: { tasks: [rawTask("a")] },
    });
    await until(() => a.agents.turns.length === 1);

    let now = 1_000;
    const notify = vi.fn();
    const res = await resumeAfterBoot({
      db: rig.db,
      orchestrator: {
        adoptJob: async () => {
          now += RESUME_WINDOW_MS + 1;
          throw new Error("log is locked");
        },
      },
      clock: { now: () => now },
      bootTimeMs: 1_000,
      notifier: { notify },
    });
    expect(res.withinDeadline).toBe(false);
    expect(res.failed).toEqual([{ jobId: id, error: "log is locked" }]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining(id));
  });
});
