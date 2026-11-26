import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { AppendedEvent, LoadResult, LoadWarning, NewEvent } from "./types.js";

const log = createSubsystemLogger("jobs/store");

/** Thrown when an append fails. The transaction was rolled back, so no partial event exists (Req 5.2). */
export class EventLogWriteError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EventLogWriteError";
    this.cause = cause;
  }
}

export function resolveEventLogPath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "jobs", "events.sqlite");
}

/** Creates the `events` table and index. Safe to call repeatedly. */
export function ensureEventLogSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      task_id TEXT,
      step_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, id);
  `);
}

/**
 * Opens (creating if needed) the Event_Log database. WAL + synchronous=FULL makes each
 * committed append durable (fsynced) before `appendEvent` returns (Req 5.1).
 * Pass `":memory:"` for tests.
 */
export function openEventLog(dbPath = resolveEventLogPath()): DatabaseSync {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  ensureEventLogSchema(db);
  return db;
}

function serializePayload(payload: unknown): string {
  // JSON.stringify returns undefined for undefined/functions/symbols and throws on cycles/BigInt.
  const json = JSON.stringify(payload === undefined ? null : payload);
  if (typeof json !== "string") throw new Error("payload is not JSON-serializable");
  return json;
}

/**
 * Appends one event in a single transaction and returns it with its assigned id.
 * Input is validated before the transaction opens; any SQLite failure rolls back and
 * throws EventLogWriteError, so callers can treat a throw as "no state change" (Req 5.2).
 * Not nest-safe: it opens its own transaction, so callers must not already be in one.
 */
export function appendEvent(db: DatabaseSync, e: NewEvent): AppendedEvent {
  if (typeof e.jobId !== "string" || e.jobId.length === 0) {
    throw new EventLogWriteError("event write failed: jobId must be a non-empty string");
  }
  if (typeof e.type !== "string" || e.type.length === 0) {
    throw new EventLogWriteError("event write failed: type must be a non-empty string");
  }
  const createdAtMs = e.createdAtMs ?? Date.now();
  if (!Number.isSafeInteger(createdAtMs)) {
    throw new EventLogWriteError("event write failed: createdAtMs must be an integer");
  }
  let payloadJson: string;
  try {
    payloadJson = serializePayload(e.payload);
  } catch (err) {
    throw new EventLogWriteError(`event write failed: ${(err as Error).message}`, err);
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    throw new EventLogWriteError(`event write failed: ${(err as Error).message}`, err);
  }
  try {
    const res = db
      .prepare(
        "INSERT INTO events (job_id, task_id, step_id, type, payload, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(e.jobId, e.taskId ?? null, e.stepId ?? null, e.type, payloadJson, createdAtMs);
    db.exec("COMMIT");
    return {
      id: Number(res.lastInsertRowid),
      jobId: e.jobId,
      ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
      ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
      type: e.type,
      payload: JSON.parse(payloadJson) as unknown,
      createdAtMs,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failed statement may already have ended the transaction; nothing left to undo.
    }
    throw new EventLogWriteError(`event write failed: ${(err as Error).message}`, err);
  }
}

type Row = {
  id: unknown;
  job_id: unknown;
  task_id: unknown;
  step_id: unknown;
  type: unknown;
  payload: unknown;
  created_at_ms: unknown;
};

/** Returns the parsed event, or a string describing why the row is unreadable. */
function parseRow(row: Row): AppendedEvent | string {
  if (typeof row.id !== "number" && typeof row.id !== "bigint") return "id is not an integer";
  if (typeof row.job_id !== "string" || row.job_id.length === 0) return "job_id is missing";
  if (typeof row.type !== "string" || row.type.length === 0) return "type is missing";
  if (typeof row.created_at_ms !== "number" && typeof row.created_at_ms !== "bigint") {
    return "created_at_ms is not an integer";
  }
  if (typeof row.payload !== "string") return "payload is not text";
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (err) {
    return `payload is not valid JSON (${(err as Error).message})`;
  }
  return {
    id: Number(row.id),
    jobId: row.job_id,
    ...(typeof row.task_id === "string" ? { taskId: row.task_id } : {}),
    ...(typeof row.step_id === "string" ? { stepId: row.step_id } : {}),
    type: row.type,
    payload,
    createdAtMs: Number(row.created_at_ms),
  };
}

/**
 * Loads events in ascending id order, returning warnings instead of only logging them.
 * An unparseable final row (a write cut off by a crash) is dropped (Req 5.12). An
 * unparseable interior row is also skipped with a warning so boot never throws.
 */
export function loadEventsWithWarnings(db: DatabaseSync, jobId?: string): LoadResult {
  const sql =
    "SELECT id, job_id, task_id, step_id, type, payload, created_at_ms FROM events" +
    (jobId === undefined ? "" : " WHERE job_id = ?") +
    " ORDER BY id ASC";
  const stmt = db.prepare(sql);
  const rows = (jobId === undefined ? stmt.all() : stmt.all(jobId)) as Row[];

  const events: AppendedEvent[] = [];
  const warnings: LoadWarning[] = [];
  rows.forEach((row, i) => {
    const parsed = parseRow(row);
    if (typeof parsed !== "string") {
      events.push(parsed);
      return;
    }
    const isFinal = i === rows.length - 1;
    warnings.push({
      eventId: typeof row.id === "number" || typeof row.id === "bigint" ? Number(row.id) : null,
      position: isFinal ? "final" : "interior",
      reason: parsed,
    });
  });
  return { events, warnings };
}

/** Loads events in ascending id order and logs a warning for each discarded row. */
export function loadEvents(db: DatabaseSync, jobId?: string): AppendedEvent[] {
  const { events, warnings } = loadEventsWithWarnings(db, jobId);
  for (const w of warnings) {
    log.warn(
      `discarded ${w.position} event row${w.eventId === null ? "" : ` id=${w.eventId}`}: ${w.reason}`,
    );
  }
  return events;
}
