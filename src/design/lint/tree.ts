import path from "node:path";

export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "other";
}

/** Directory names never scanned. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist"]);

/** File extensions the Design_Linter scans. */
export const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".css",
  ".js",
  ".jsx",
  ".html",
]);

/** Bounded-concurrency map that keeps result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface WalkResult {
  /** Absolute paths of scannable files, sorted. */
  files: string[];
  /** Directories that could not be listed, with the reason. */
  unreadable: Array<{ path: string; reason: string }>;
}

/**
 * Lists every scannable file under `root`, skipping `node_modules` and `dist`.
 * Walks one directory level at a time so listings run concurrently.
 */
export async function collectSourceFiles(
  root: string,
  listDir: (dir: string) => Promise<DirEntry[]>,
  concurrency: number,
): Promise<WalkResult> {
  const files: string[] = [];
  const unreadable: WalkResult["unreadable"] = [];
  let level = [root];
  while (level.length > 0) {
    const listings = await mapLimit(level, concurrency, async (dir) => {
      try {
        return { dir, entries: await listDir(dir) };
      } catch (err) {
        unreadable.push({ path: dir, reason: (err as Error).message });
        return { dir, entries: [] as DirEntry[] };
      }
    });
    const nextLevel: string[] = [];
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.kind === "dir") {
          if (!SKIPPED_DIRS.has(entry.name)) {
            nextLevel.push(full);
          }
        } else if (entry.kind === "file" && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(full);
        }
      }
    }
    level = nextLevel;
  }
  files.sort();
  unreadable.sort((a, b) => a.path.localeCompare(b.path));
  return { files, unreadable };
}
