import crypto from "node:crypto";
import type { OpenMuseDatabase, TaskRow } from "../db/schema.js";
import { LeaseManager } from "./lease-manager.js";

export type TaskHandler = (input: unknown, taskId: string) => Promise<unknown>;

export class TaskRunner {
  private db: OpenMuseDatabase;
  private leaseManager: LeaseManager;
  private workerId: string;
  private handlers: Map<string, TaskHandler> = new Map();
  private isRunning: boolean = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private concurrency: number;
  private activeWorkers: number = 0;

  constructor(db: OpenMuseDatabase, concurrency: number = 2) {
    this.db = db;
    this.leaseManager = new LeaseManager(db);
    this.workerId = `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    this.concurrency = concurrency;
  }

  public registerHandler(category: string, handler: TaskHandler): void {
    this.handlers.set(category, handler);
  }

  public createTask(category: string, input?: unknown, maxRetries: number = 3): TaskRow {
    const now = Date.now();
    const id = `task-${now}-${crypto.randomBytes(4).toString("hex")}`;
    const inputJson = input !== undefined ? JSON.stringify(input) : null;

    const stmt = this.db.db.prepare(`
      INSERT INTO tasks (id, category, status, input_json, retry_count, max_retries, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)
    `);
    stmt.run(id, category, inputJson, maxRetries, now, now);

    return {
      id,
      category,
      status: "pending",
      input_json: inputJson,
      result_json: null,
      error: null,
      retry_count: 0,
      max_retries: maxRetries,
      created_at: now,
      updated_at: now,
    };
  }

  public getTask(taskId: string): TaskRow | null {
    const stmt = this.db.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(taskId) as TaskRow | undefined;
    return row ?? null;
  }

  public cancelTask(taskId: string): boolean {
    const now = Date.now();
    const stmt = this.db.db.prepare(`
      UPDATE tasks
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running', 'paused')
    `);
    const res = stmt.run(now, taskId);
    if (res.changes > 0) {
      this.db.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.clearHeartbeat(taskId);
      return true;
    }
    return false;
  }

  public pauseTask(taskId: string): boolean {
    const now = Date.now();
    const stmt = this.db.db.prepare(`
      UPDATE tasks
      SET status = 'paused', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')
    `);
    const res = stmt.run(now, taskId);
    if (res.changes > 0) {
      this.db.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(taskId);
      this.clearHeartbeat(taskId);
      return true;
    }
    return false;
  }

  public resumeTask(taskId: string): boolean {
    const now = Date.now();
    const stmt = this.db.db.prepare(`
      UPDATE tasks
      SET status = 'pending', updated_at = ?
      WHERE id = ? AND status = 'paused'
    `);
    const res = stmt.run(now, taskId);
    return res.changes > 0;
  }

  public listTasks(status?: string, limit: number = 20): TaskRow[] {
    if (status) {
      const stmt = this.db.db.prepare(`
        SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?
      `);
      return stmt.all(status, limit) as TaskRow[];
    }
    const stmt = this.db.db.prepare(`
      SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(limit) as TaskRow[];
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextTick(100);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const [taskId] of this.heartbeatTimers) {
      this.clearHeartbeat(taskId);
    }
  }

  private scheduleNextTick(delayMs: number = 1000): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(() => {
      this.tick().finally(() => {
        this.scheduleNextTick(this.activeWorkers < this.concurrency ? 500 : 1500);
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.activeWorkers >= this.concurrency) return;

    const task = this.leaseManager.acquireNextTask(this.workerId, 30000);
    if (!task) return;

    this.activeWorkers++;
    this.startHeartbeat(task.id);

    try {
      const handler = this.handlers.get(task.category);
      if (!handler) {
        throw new Error(`No registered worker handler for task category: ${task.category}`);
      }

      let parsedInput: unknown = null;
      if (task.input_json) {
        try {
          parsedInput = JSON.parse(task.input_json);
        } catch {
          parsedInput = task.input_json;
        }
      }

      const result = await handler(parsedInput, task.id);
      this.clearHeartbeat(task.id);
      this.leaseManager.releaseTask(task.id, this.workerId, {
        status: "completed",
        result,
      });
    } catch (err: any) {
      this.clearHeartbeat(task.id);
      const errorMessage = err?.message || String(err);
      this.leaseManager.releaseTask(task.id, this.workerId, {
        status: "failed",
        error: errorMessage,
      });
    } finally {
      this.activeWorkers--;
    }
  }

  private startHeartbeat(taskId: string): void {
    this.clearHeartbeat(taskId);
    const interval = setInterval(() => {
      if (!this.isRunning) {
        this.clearHeartbeat(taskId);
        return;
      }
      const ok = this.leaseManager.heartbeat(taskId, this.workerId, 30000);
      if (!ok) {
        this.clearHeartbeat(taskId);
      }
    }, 10000);
    this.heartbeatTimers.set(taskId, interval);
  }

  private clearHeartbeat(taskId: string): void {
    const timer = this.heartbeatTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(taskId);
    }
  }
}
