// Local file index: Sir chooses folders (notes, PDFs, college material, project docs) and
// FRIDAY can search them by keyword and cite the file and page. Everything stays on this
// machine in SQLite full-text search; only the snippets she reads go to the model.
// Re-indexing is incremental: a file is only read again when its size or mtime changed.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { MAX_FILE_BYTES, chunkSection, extractText, fileKind } from "./extract.js";

const log = createSubsystemLogger("files");

// Folders that are never worth reading: dependencies, build output, caches, VCS internals.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
  "site-packages",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  "Pods",
  "DerivedData",
]);
const MAX_FILES_PER_SYNC = 20_000;

export type Root = { path: string; addedAt: string };
export type Hit = { path: string; loc: string; snippet: string; modified: string };
export type IndexStatus = {
  folders: string[];
  files: number;
  chunks: number;
  lastSync: string | null;
  syncing: boolean;
};

const dir = (stateDir = resolveStateDir()) => path.join(stateDir, "files");
const rootsFile = (stateDir?: string) => path.join(dir(stateDir), "roots.json");

export function listRoots(stateDir?: string): Root[] {
  try {
    return JSON.parse(fs.readFileSync(rootsFile(stateDir), "utf-8")) as Root[];
  } catch {
    return [];
  }
}

function saveRoots(roots: Root[], stateDir?: string) {
  fs.mkdirSync(dir(stateDir), { recursive: true });
  fs.writeFileSync(rootsFile(stateDir), JSON.stringify(roots, null, 2));
}

export function addRoot(folder: string, stateDir?: string): Root[] {
  const abs = path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
    throw new Error(`Not a folder: ${abs}`);
  const home = process.env.HOME ?? "";
  if (abs === "/" || abs === home)
    throw new Error("Choose specific folders, not the whole disk or home folder.");
  const roots = listRoots(stateDir).filter((r) => r.path !== abs);
  roots.push({ path: abs, addedAt: new Date().toISOString() });
  saveRoots(roots, stateDir);
  return roots;
}

export function removeRoot(folder: string, stateDir?: string): Root[] {
  const abs = path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  const roots = listRoots(stateDir).filter((r) => r.path !== abs);
  saveRoots(roots, stateDir);
  const db = open(stateDir);
  db.prepare("DELETE FROM chunks WHERE path = ? OR path LIKE ?").run(abs, `${abs}/%`);
  db.prepare("DELETE FROM docs WHERE path = ? OR path LIKE ?").run(abs, `${abs}/%`);
  return roots;
}

const dbs = new Map<string, DatabaseSync>();

function open(stateDir?: string): DatabaseSync {
  const file = path.join(dir(stateDir), "index.sqlite");
  const cached = dbs.get(file);
  if (cached) return cached;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, indexed_at TEXT);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      path UNINDEXED, loc UNINDEXED, name, text, tokenize = 'porter unicode61'
    );
  `);
  dbs.set(file, db);
  return db;
}

/** Every indexable file under the roots (skipping hidden and dependency/build folders). */
function walk(roots: Root[]): Map<string, fs.Stats> {
  const found = new Map<string, fs.Stats>();
  const stack = roots.map((r) => r.path);
  while (stack.length && found.size < MAX_FILES_PER_SYNC) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && fileKind(full)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0 && st.size <= MAX_FILE_BYTES) found.set(full, st);
        } catch {
          // vanished mid-walk
        }
      }
    }
  }
  return found;
}

let syncing: Promise<{ indexed: number; removed: number }> | null = null;

/** Bring the index up to date with the chosen folders. One sync at a time. */
export function syncIndex(stateDir?: string): Promise<{ indexed: number; removed: number }> {
  syncing ??= doSync(stateDir).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync(stateDir?: string) {
  const db = open(stateDir);
  const files = walk(listRoots(stateDir));
  const known = new Map(
    (
      db.prepare("SELECT path, size, mtime FROM docs").all() as Array<{
        path: string;
        size: number;
        mtime: number;
      }>
    ).map((r) => [r.path, r]),
  );
  let indexed = 0;
  let removed = 0;
  for (const p of known.keys()) {
    if (files.has(p)) continue;
    db.prepare("DELETE FROM chunks WHERE path = ?").run(p);
    db.prepare("DELETE FROM docs WHERE path = ?").run(p);
    removed++;
  }
  for (const [file, st] of files) {
    const prev = known.get(file);
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
    let sections: Awaited<ReturnType<typeof extractText>> = [];
    try {
      sections = await extractText(file);
    } catch (err) {
      log.debug(`skip ${file}: ${String(err)}`);
    }
    const name = path.basename(file);
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM chunks WHERE path = ?").run(file);
      const insert = db.prepare("INSERT INTO chunks (path, loc, name, text) VALUES (?, ?, ?, ?)");
      for (const s of sections)
        for (const chunk of chunkSection(s.text)) insert.run(file, s.loc, name, chunk);
      // Unreadable files are recorded too, so they aren't retried until they change.
      db.prepare(
        "INSERT OR REPLACE INTO docs (path, size, mtime, indexed_at) VALUES (?, ?, ?, ?)",
      ).run(file, st.size, st.mtimeMs, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    indexed++;
    // Let the gateway breathe between files.
    if (indexed % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)").run(
    new Date().toISOString(),
  );
  if (indexed || removed)
    log.info(`file index: ${indexed} indexed, ${removed} removed, ${files.size} total`);
  return { indexed, removed };
}

/** Words of the query as an FTS expression: all words first, any word if that finds nothing. */
function ftsQuery(query: string, mode: "AND" | "OR"): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.map((w) => `"${w}"*`).join(` ${mode} `);
}

export function searchFiles(
  query: string,
  opts: { folder?: string; limit?: number; stateDir?: string } = {},
): Hit[] {
  const db = open(opts.stateDir);
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
  const folder = opts.folder
    ? path.resolve(opts.folder.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))
    : null;
  for (const mode of ["AND", "OR"] as const) {
    const match = ftsQuery(query, mode);
    if (!match) return [];
    const rows = db
      .prepare(
        `SELECT chunks.path AS path, chunks.loc AS loc,
                snippet(chunks, 3, '«', '»', ' … ', 40) AS snippet, docs.mtime AS mtime
         FROM chunks JOIN docs ON docs.path = chunks.path
         WHERE chunks MATCH ? ${folder ? "AND chunks.path LIKE ?" : ""}
         ORDER BY bm25(chunks, 0, 0, 4.0, 1.0) LIMIT ?`,
      )
      .all(
        ...([match, ...(folder ? [`${folder}/%`] : []), limit] as [
          string,
          ...Array<string | number>,
        ]),
      ) as Array<{
      path: string;
      loc: string;
      snippet: string;
      mtime: number;
    }>;
    if (rows.length) {
      return rows.map((r) => ({
        path: r.path,
        loc: r.loc,
        snippet: r.snippet.replace(/\s+/g, " ").trim(),
        modified: new Date(r.mtime).toISOString().slice(0, 10),
      }));
    }
  }
  return [];
}

export function indexStatus(stateDir?: string): IndexStatus {
  const db = open(stateDir);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const last = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as
    | { value: string }
    | undefined;
  return {
    folders: listRoots(stateDir).map((r) => r.path),
    files: count("SELECT count(*) AS n FROM docs"),
    chunks: count("SELECT count(*) AS n FROM chunks"),
    lastSync: last?.value ?? null,
    syncing: syncing !== null,
  };
}

/** Background upkeep while the gateway runs: first sync after a minute, then every 30 minutes. */
export function startFileIndexSchedule(): () => void {
  const tick = () => {
    if (!listRoots().length) return;
    void syncIndex().catch((err) => log.warn(`file index sync failed: ${String(err)}`));
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 30 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
