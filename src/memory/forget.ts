// "Forget X": tombstones that keep a phrase out of recall permanently.
//
// Forgetting removes matching chunks from the index, deletes matching lines from curated
// memory files (MEMORY.md, memory/*.md), and records the phrase so later reindexing and
// searches skip it. Conversation transcripts stay on disk as the audit record, but anything
// matching a tombstone is never indexed or returned again.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type Tombstone = { phrase: string; createdAt: number };

export const MIN_FORGET_PHRASE_LENGTH = 3;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function tombstoneFileFor(indexDbPath: string): string {
  return path.join(path.dirname(indexDbPath), "forgotten.json");
}

// Cached by file mtime: indexing checks every chunk, so avoid re-reading the file each time.
let cache: { file: string; mtimeMs: number; items: Tombstone[] } | null = null;

export function loadTombstones(file: string): Tombstone[] {
  let mtimeMs: number;
  try {
    mtimeMs = fsSync.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.items;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf-8")) as unknown;
    const items = Array.isArray(parsed)
      ? parsed.filter(
          (t): t is Tombstone =>
            typeof t?.phrase === "string" && t.phrase.trim().length >= MIN_FORGET_PHRASE_LENGTH,
        )
      : [];
    cache = { file, mtimeMs, items };
    return items;
  } catch {
    return [];
  }
}

export async function addTombstone(
  file: string,
  phrase: string,
  nowMs = Date.now(),
): Promise<void> {
  const existing = loadTombstones(file);
  if (existing.some((t) => normalize(t.phrase) === normalize(phrase))) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = [...existing, { phrase: phrase.trim(), createdAt: nowMs }];
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, file);
  cache = null;
}

export function matchesTombstone(text: string, tombstones: Tombstone[]): boolean {
  if (tombstones.length === 0) return false;
  const hay = normalize(text);
  return tombstones.some((t) => hay.includes(normalize(t.phrase)));
}

/** Drop every line that mentions the phrase (case-insensitive). */
export function removeLinesContaining(
  content: string,
  phrase: string,
): { content: string; removed: number } {
  const needle = normalize(phrase);
  const lines = content.split("\n");
  const kept = lines.filter((line) => !normalize(line).includes(needle));
  return { content: kept.join("\n"), removed: lines.length - kept.length };
}
