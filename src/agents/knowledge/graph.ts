// Knowledge graph (inspired by Graphiti / mem0): the people, organisations, projects, places
// and things in Sir's life, and dated facts connecting them. Facts are temporal: when a new
// fact replaces an old one for a single-valued relation (a new job, a new city) the old fact
// is marked invalid instead of deleted, so FRIDAY knows both the present and the history.
// Local SQLite under the state dir.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveStateDir } from "../../config/paths.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

export type EntityType = "person" | "organization" | "project" | "place" | "thing" | "event";

export type Entity = {
  id: number;
  name: string;
  type: EntityType;
  summary: string;
  aliases: string[];
  mentions: number;
  firstSeen: string;
  lastSeen: string;
};

export type Fact = {
  id: number;
  subject: string;
  relation: string;
  object: string;
  objectIsEntity: boolean;
  fact: string;
  validFrom: string;
  invalidAt: string | null;
  source: string;
  confidence: number;
};

// Relations where a newer value replaces the old one.
const SINGLE_VALUED = new Set([
  "works_at",
  "employed_by",
  "role",
  "title",
  "job",
  "lives_in",
  "based_in",
  "located_in",
  "status",
  "phone",
  "email",
  "birthday",
  "manager",
  "reports_to",
  "spouse",
  "partner",
  "age",
  "owns_company",
  "ceo",
]);

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const relNorm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "related_to";

let cached: { file: string; db: DatabaseSync } | null = null;

export function openGraph(stateDir = resolveStateDir()): DatabaseSync {
  const file = path.join(stateDir, "knowledge", "graph.sqlite");
  if (cached?.file === file) return cached.db;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      norm TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'thing',
      summary TEXT NOT NULL DEFAULT '',
      aliases TEXT NOT NULL DEFAULT '[]',
      mentions INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY,
      src INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      rel TEXT NOT NULL,
      dst INTEGER REFERENCES entities(id) ON DELETE CASCADE,
      value TEXT,
      fact TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      invalid_at TEXT,
      source TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.8
    );
    CREATE INDEX IF NOT EXISTS facts_src ON facts(src);
    CREATE INDEX IF NOT EXISTS facts_dst ON facts(dst);
  `);
  db.exec("PRAGMA foreign_keys = ON;");
  if (cached && cached.file !== file) cached.db.close();
  cached = { file, db };
  return db;
}

export function closeGraph() {
  cached?.db.close();
  cached = null;
}

type EntityRow = {
  id: number;
  name: string;
  type: string;
  summary: string;
  aliases: string;
  mentions: number;
  first_seen: string;
  last_seen: string;
};

const toEntity = (r: EntityRow): Entity => ({
  id: r.id,
  name: r.name,
  type: r.type as EntityType,
  summary: r.summary,
  aliases: JSON.parse(r.aliases || "[]"),
  mentions: r.mentions,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

export function findEntity(name: string, db = openGraph()): Entity | null {
  const n = norm(name);
  const row =
    (db.prepare("SELECT * FROM entities WHERE norm = ?").get(n) as EntityRow | undefined) ??
    (db
      .prepare(
        "SELECT e.* FROM entities e, json_each(e.aliases) a WHERE lower(a.value) = ? LIMIT 1",
      )
      .get(n) as EntityRow | undefined);
  return row ? toEntity(row) : null;
}

export function upsertEntity(
  input: { name: string; type?: string; summary?: string; alias?: string },
  opts: { at?: string; db?: DatabaseSync } = {},
): Entity {
  const db = opts.db ?? openGraph();
  const at = opts.at ?? new Date().toISOString();
  const name = input.name.trim().slice(0, 120);
  const existing = findEntity(name, db);
  if (existing) {
    const summary =
      input.summary?.trim() && input.summary.trim().length > existing.summary.length
        ? input.summary.trim()
        : existing.summary;
    const aliases = new Set(existing.aliases);
    if (input.alias && norm(input.alias) !== norm(existing.name)) aliases.add(input.alias.trim());
    const type = existing.type === "thing" && input.type ? input.type : existing.type;
    db.prepare(
      "UPDATE entities SET summary = ?, aliases = ?, type = ?, mentions = mentions + 1, last_seen = ? WHERE id = ?",
    ).run(summary.slice(0, 400), JSON.stringify([...aliases]), type, at, existing.id);
    return findEntity(name, db)!;
  }
  db.prepare(
    "INSERT INTO entities (name, norm, type, summary, aliases, mentions, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(
    name,
    norm(name),
    input.type || "thing",
    (input.summary ?? "").trim().slice(0, 400),
    "[]",
    at,
    at,
  );
  return findEntity(name, db)!;
}

/** Record a fact. Same fact again: refreshed. Contradicts a single-valued relation: old one invalidated. */
export function addFact(
  input: {
    subject: string;
    subjectType?: string;
    relation: string;
    object: string;
    objectType?: string;
    objectIsEntity?: boolean;
    fact?: string;
    source?: string;
    confidence?: number;
  },
  opts: { at?: string; db?: DatabaseSync } = {},
): { id: number; created: boolean; superseded: number } {
  const db = opts.db ?? openGraph();
  const at = opts.at ?? new Date().toISOString();
  const src = upsertEntity({ name: input.subject, type: input.subjectType }, { at, db });
  const rel = relNorm(input.relation);
  const isEntity = input.objectIsEntity ?? true;
  const dst = isEntity
    ? upsertEntity({ name: input.object, type: input.objectType }, { at, db })
    : null;
  const value = isEntity ? null : input.object.trim().slice(0, 300);
  const text = (input.fact ?? `${input.subject} ${rel.replace(/_/g, " ")} ${input.object}`)
    .trim()
    .slice(0, 400);

  const current = db
    .prepare("SELECT id, dst, value FROM facts WHERE src = ? AND rel = ? AND invalid_at IS NULL")
    .all(src.id, rel) as Array<{ id: number; dst: number | null; value: string | null }>;
  const same = current.find((f) =>
    dst ? f.dst === dst.id : f.value !== null && norm(f.value) === norm(value!),
  );
  if (same) {
    db.prepare("UPDATE facts SET confidence = MIN(1.0, confidence + 0.05) WHERE id = ?").run(
      same.id,
    );
    return { id: same.id, created: false, superseded: 0 };
  }
  let superseded = 0;
  if (SINGLE_VALUED.has(rel)) {
    superseded = Number(
      db
        .prepare("UPDATE facts SET invalid_at = ? WHERE src = ? AND rel = ? AND invalid_at IS NULL")
        .run(at, src.id, rel).changes,
    );
  }
  const res = db
    .prepare(
      "INSERT INTO facts (src, rel, dst, value, fact, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      src.id,
      rel,
      dst?.id ?? null,
      value,
      text,
      at,
      (input.source ?? "").slice(0, 200),
      input.confidence ?? 0.8,
    );
  return { id: Number(res.lastInsertRowid), created: true, superseded };
}

type FactRow = {
  id: number;
  src_name: string;
  rel: string;
  dst_name: string | null;
  value: string | null;
  fact: string;
  valid_from: string;
  invalid_at: string | null;
  source: string;
  confidence: number;
};

const FACT_SELECT = `SELECT f.id, s.name AS src_name, f.rel, d.name AS dst_name, f.value, f.fact, f.valid_from, f.invalid_at, f.source, f.confidence
  FROM facts f JOIN entities s ON s.id = f.src LEFT JOIN entities d ON d.id = f.dst`;

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  subject: r.src_name,
  relation: r.rel,
  object: r.dst_name ?? r.value ?? "",
  objectIsEntity: r.dst_name !== null,
  fact: r.fact,
  validFrom: r.valid_from,
  invalidAt: r.invalid_at,
  source: r.source,
  confidence: r.confidence,
});

/** An entity with its current facts (both directions) and superseded history. */
export function lookup(
  name: string,
  db = openGraph(),
): { entity: Entity; facts: Fact[]; history: Fact[] } | null {
  const entity = findEntity(name, db);
  if (!entity) return null;
  const rows = db
    .prepare(`${FACT_SELECT} WHERE f.src = ? OR f.dst = ? ORDER BY f.valid_from DESC LIMIT 60`)
    .all(entity.id, entity.id) as FactRow[];
  const facts = rows.map(toFact);
  return {
    entity,
    facts: facts.filter((f) => !f.invalidAt),
    history: facts.filter((f) => f.invalidAt),
  };
}

export function search(query: string, db = openGraph()): { entities: Entity[]; facts: Fact[] } {
  const q = `%${query.trim().toLowerCase()}%`;
  const entities = (
    db
      .prepare(
        "SELECT * FROM entities WHERE norm LIKE ? OR lower(summary) LIKE ? OR lower(aliases) LIKE ? ORDER BY mentions DESC LIMIT 20",
      )
      .all(q, q, q) as EntityRow[]
  ).map(toEntity);
  const facts = (
    db
      .prepare(
        `${FACT_SELECT} WHERE f.invalid_at IS NULL AND (lower(f.fact) LIKE ? OR lower(f.value) LIKE ?) ORDER BY f.valid_from DESC LIMIT 30`,
      )
      .all(q, q) as FactRow[]
  ).map(toFact);
  return { entities, facts };
}

export function listEntities(type?: string, db = openGraph()): Entity[] {
  const rows = type
    ? (db
        .prepare(
          "SELECT * FROM entities WHERE type = ? ORDER BY mentions DESC, last_seen DESC LIMIT 200",
        )
        .all(type) as EntityRow[])
    : (db
        .prepare("SELECT * FROM entities ORDER BY mentions DESC, last_seen DESC LIMIT 200")
        .all() as EntityRow[]);
  return rows.map(toEntity);
}

export function forgetEntity(name: string, db = openGraph()): boolean {
  const e = findEntity(name, db);
  if (!e) return false;
  db.prepare("DELETE FROM facts WHERE src = ? OR dst = ?").run(e.id, e.id);
  db.prepare("DELETE FROM entities WHERE id = ?").run(e.id);
  return true;
}

export function forgetFact(id: number, db = openGraph()): boolean {
  return Number(db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes) > 0;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Who-is-who for a message: entities it mentions (by name or alias, whole words) with their
 * current facts, compact enough for the system prompt. Empty when nothing known is mentioned.
 */
export function contextFor(
  text: string,
  opts: { maxEntities?: number; maxChars?: number; db?: DatabaseSync } = {},
): string {
  const db = opts.db ?? openGraph();
  const lower = text.toLowerCase();
  if (!lower.trim()) return "";
  const rows = db
    .prepare("SELECT * FROM entities WHERE length(norm) >= 3 ORDER BY mentions DESC LIMIT 2000")
    .all() as EntityRow[];
  const hits: Entity[] = [];
  for (const r of rows) {
    const e = toEntity(r);
    if (norm(e.name) === "sir") continue;
    const names = [e.name, ...e.aliases].filter((n) => n.trim().length >= 3);
    if (
      names.some((n) =>
        new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n.toLowerCase())}($|[^\\p{L}\\p{N}])`, "u").test(
          lower,
        ),
      )
    ) {
      hits.push(e);
      if (hits.length >= (opts.maxEntities ?? 5)) break;
    }
  }
  if (!hits.length) return "";
  const maxChars = opts.maxChars ?? 1200;
  const lines: string[] = [];
  for (const e of hits) {
    const facts = lookup(e.name, db)?.facts.slice(0, 6) ?? [];
    const head = `- ${e.name} (${e.type})${e.summary ? `: ${e.summary}` : ""}`;
    const body = facts.map((f) => f.fact).join("; ");
    lines.push(body ? `${head}. Known: ${body}` : head);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}
