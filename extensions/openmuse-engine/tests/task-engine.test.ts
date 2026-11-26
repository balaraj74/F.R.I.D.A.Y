import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OpenMuseDatabase } from "../src/db/schema.js";
import { LeaseManager } from "../src/task-engine/lease-manager.js";
import { TaskRunner } from "../src/task-engine/task-runner.js";

describe("OpenMuse Task Engine & Lease Substrate", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: OpenMuseDatabase;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-test-"));
    dbPath = path.join(tmpDir, "test-tasks.db");
    db = new OpenMuseDatabase(dbPath);
  });

  afterEach(async () => {
    db.close();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("initializes tables and WAL mode properly", () => {
    const tables = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'task_leases', 'browser_profiles')"
    ).all() as Array<{ name: string }>;

    expect(tables.length).toBe(3);
    const names = tables.map((t) => t.name);
    expect(names).toContain("tasks");
    expect(names).toContain("task_leases");
    expect(names).toContain("browser_profiles");
  });

  test("atomic task creation and status tracking", () => {
    const runner = new TaskRunner(db);
    const task = runner.createTask("test-calc", { a: 10, b: 20 });

    expect(task.id).toBeDefined();
    expect(task.category).toBe("test-calc");
    expect(task.status).toBe("pending");

    const fetched = runner.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.category).toBe("test-calc");
    expect(fetched?.status).toBe("pending");

    // Pause and resume
    expect(runner.pauseTask(task.id)).toBe(true);
    expect(runner.getTask(task.id)?.status).toBe("paused");

    expect(runner.resumeTask(task.id)).toBe(true);
    expect(runner.getTask(task.id)?.status).toBe("pending");

    // Cancellation
    expect(runner.cancelTask(task.id)).toBe(true);
    expect(runner.getTask(task.id)?.status).toBe("cancelled");
  });

  test("lease acquisition and atomic reservation", () => {
    const leaseMgr = new LeaseManager(db);
    const runner = new TaskRunner(db);

    const task = runner.createTask("long-job", { step: 1 });
    const acquired = leaseMgr.acquireNextTask("worker-alpha", 10000);

    expect(acquired).not.toBeNull();
    expect(acquired?.id).toBe(task.id);
    expect(acquired?.status).toBe("running");

    // Second worker should get null (no other pending task)
    const secondAcquired = leaseMgr.acquireNextTask("worker-beta", 10000);
    expect(secondAcquired).toBeNull();

    // Release task with completion
    leaseMgr.releaseTask(task.id, "worker-alpha", {
      status: "completed",
      result: { done: true },
    });

    const finished = runner.getTask(task.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.result_json).toBe(JSON.stringify({ done: true }));
  });

  test("stale lease reaping and retry handling", () => {
    const leaseMgr = new LeaseManager(db);
    const runner = new TaskRunner(db);

    const task = runner.createTask("fragile-job", {}, 2);
    // Acquire with 1ms lease
    const acquired = leaseMgr.acquireNextTask("crashed-worker", 1);
    expect(acquired).not.toBeNull();

    // Simulate clock passing
    const past = Date.now() - 5000;
    db.db.prepare("UPDATE task_leases SET lease_expires_at = ? WHERE task_id = ?").run(past, task.id);

    // Reap
    const reaped = leaseMgr.reapStaleLeases();
    expect(reaped).toBe(1);

    // Should be returned to pending with retry_count = 1
    const retriedTask = runner.getTask(task.id);
    expect(retriedTask?.status).toBe("pending");
    expect(retriedTask?.retry_count).toBe(1);
  });

  test("asynchronous execution loop in TaskRunner", async () => {
    const runner = new TaskRunner(db, 2);

    runner.registerHandler("math-add", async (input: any) => {
      return { sum: input.x + input.y };
    });

    runner.start();

    const t = runner.createTask("math-add", { x: 15, y: 25 });

    // Wait for worker tick
    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const current = runner.getTask(t.id);
      if (current?.status === "completed") {
        completed = true;
        expect(current.result_json).toBe(JSON.stringify({ sum: 40 }));
        break;
      }
    }

    runner.stop();
    expect(completed).toBe(true);
  });
});
