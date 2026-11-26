import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

export type TaskRow = {
  id: string;
  category: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused";
  input_json: string | null;
  result_json: string | null;
  error: string | null;
  retry_count: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
};

export type TaskLeaseRow = {
  task_id: string;
  worker_id: string;
  lease_expires_at: number;
  heartbeat_at: number;
};

export type BrowserProfileRow = {
  profile_id: string;
  data_dir: string;
  created_at: number;
  last_active_at: number;
  metadata_json: string | null;
};

export class OpenMuseDatabase {
  public db: DatabaseSync;

  constructor(dbPath?: string) {
    const targetPath =
      dbPath || path.join(os.homedir(), ".friday", "openmuse", "tasks.db");
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    this.db = new DatabaseSync(targetPath);
    this.initTables();
  }

  private initTables(): void {
    // Configure WAL mode for durability & concurrency
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    // Tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    `);

    // Task leases table for resilient recovery across worker crashes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_leases (
        task_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_leases_expires ON task_leases(lease_expires_at);
    `);

    // Browser profiles table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        profile_id TEXT PRIMARY KEY,
        data_dir TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        metadata_json TEXT
      );
    `);
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
