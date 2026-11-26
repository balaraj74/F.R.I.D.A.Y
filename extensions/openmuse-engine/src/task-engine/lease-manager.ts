import type { OpenMuseDatabase, TaskRow } from "../db/schema.js";

export class LeaseManager {
  private db: OpenMuseDatabase;

  constructor(db: OpenMuseDatabase) {
    this.db = db;
  }

  /**
   * Atomically acquire the next available task (either pending or with an expired lease).
   */
  public acquireNextTask(workerId: string, leaseDurationMs: number = 30000): TaskRow | null {
    const now = Date.now();
    const expiresAt = now + leaseDurationMs;

    // 1. Re-queue or fail any expired leases first
    this.reapStaleLeases();

    // 2. Find a candidate task
    const stmt = this.db.db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN task_leases l ON t.id = l.task_id
      WHERE t.status = 'pending'
      ORDER BY t.created_at ASC
      LIMIT 1
    `);

    const candidate = stmt.get() as TaskRow | undefined;
    if (!candidate) return null;

    // 3. Atomically acquire with a lease
    try {
      const updateStmt = this.db.db.prepare(`
        UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'
      `);
      const res = updateStmt.run(now, candidate.id);
      if (res.changes === 0) {
        // Lost race to another worker
        return null;
      }

      const leaseStmt = this.db.db.prepare(`
        INSERT INTO task_leases (task_id, worker_id, lease_expires_at, heartbeat_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at
      `);
      leaseStmt.run(candidate.id, workerId, expiresAt, now);

      candidate.status = "running";
      candidate.updated_at = now;
      return candidate;
    } catch {
      return null;
    }
  }

  /**
   * Heartbeat to extend active task lease.
   */
  public heartbeat(taskId: string, workerId: string, extensionMs: number = 30000): boolean {
    const now = Date.now();
    const expiresAt = now + extensionMs;

    const stmt = this.db.db.prepare(`
      UPDATE task_leases
      SET lease_expires_at = ?, heartbeat_at = ?
      WHERE task_id = ? AND worker_id = ?
    `);
    const res = stmt.run(expiresAt, now, taskId, workerId);
    return res.changes > 0;
  }

  /**
   * Release and mark task completion or failure.
   */
  public releaseTask(
    taskId: string,
    workerId: string,
    outcome: {
      status: "completed" | "failed" | "cancelled";
      result?: unknown;
      error?: string;
    }
  ): void {
    const now = Date.now();
    const resultJson = outcome.result !== undefined ? JSON.stringify(outcome.result) : null;
    const errorText = outcome.error ?? null;

    // Remove lease
    this.db.db.prepare(`DELETE FROM task_leases WHERE task_id = ? AND worker_id = ?`).run(taskId, workerId);

    // Update task
    this.db.db.prepare(`
      UPDATE tasks
      SET status = ?, result_json = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(outcome.status, resultJson, errorText, now, taskId);
  }

  /**
   * Reap stale leases: tasks whose lease expired and worker ceased heartbeat.
   */
  public reapStaleLeases(): number {
    const now = Date.now();

    const staleRows = this.db.db.prepare(`
      SELECT t.id, t.retry_count, t.max_retries
      FROM tasks t
      JOIN task_leases l ON t.id = l.task_id
      WHERE t.status = 'running' AND l.lease_expires_at < ?
    `).all(now) as Array<{ id: string; retry_count: number; max_retries: number }>;

    let reapedCount = 0;
    for (const row of staleRows) {
      if (row.retry_count + 1 <= row.max_retries) {
        // Re-queue
        this.db.db.prepare(`
          UPDATE tasks
          SET status = 'pending', retry_count = retry_count + 1, updated_at = ?
          WHERE id = ?
        `).run(now, row.id);
        this.db.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(row.id);
        reapedCount++;
      } else {
        // Fail
        this.db.db.prepare(`
          UPDATE tasks
          SET status = 'failed', error = 'Lease expired without heartbeat and max retries exceeded', updated_at = ?
          WHERE id = ?
        `).run(now, row.id);
        this.db.db.prepare(`DELETE FROM task_leases WHERE task_id = ?`).run(row.id);
        reapedCount++;
      }
    }

    return reapedCount;
  }
}
