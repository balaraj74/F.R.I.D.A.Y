import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  REF_INDICES,
  SCREENS,
  STYLE_DIRECTIONS,
  type RefIndex,
  type Screen,
  type StyleDirection,
} from "./plan.js";

export const SELECTION_NOTE_MAX_LENGTH = 500;
export const SELECTION_VERDICTS = ["keep", "reject", "mix"] as const;

export type Verdict = (typeof SELECTION_VERDICTS)[number];

export type SelectionEntry = {
  screen: Screen;
  direction: StyleDirection;
  index: RefIndex;
  verdict: Verdict;
  note: string;
};

export type SelectionFile = {
  version: 1;
  entries: SelectionEntry[];
};

/** Thrown by `readSelection` (and `writeSelection` when the existing file is unreadable as a selection). */
export class SelectionParseError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(filePath: string, reason: string) {
    super(`Malformed selection file ${filePath}: ${reason}`);
    this.name = "SelectionParseError";
    this.path = filePath;
    this.reason = reason;
  }
}

/** Thrown by `writeSelection` when the input is invalid; nothing is written to disk. */
export class SelectionValidationError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "SelectionValidationError";
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a reason string when `value` is not a valid SelectionFile, otherwise null. */
function validateSelectionFile(value: unknown): string | null {
  if (!isRecord(value)) {
    return "expected a JSON object";
  }
  if (value.version !== 1) {
    return "version must be 1";
  }
  if (!Array.isArray(value.entries)) {
    return "entries must be an array";
  }
  for (const [i, entry] of value.entries.entries()) {
    const at = `entries[${i}]`;
    if (!isRecord(entry)) {
      return `${at} must be an object`;
    }
    if (!(SCREENS as readonly unknown[]).includes(entry.screen)) {
      return `${at}.screen must be one of ${SCREENS.join(", ")}`;
    }
    if (!(STYLE_DIRECTIONS as readonly unknown[]).includes(entry.direction)) {
      return `${at}.direction must be one of ${STYLE_DIRECTIONS.join(", ")}`;
    }
    if (!(REF_INDICES as readonly unknown[]).includes(entry.index)) {
      return `${at}.index must be one of ${REF_INDICES.join(", ")}`;
    }
    if (!(SELECTION_VERDICTS as readonly unknown[]).includes(entry.verdict)) {
      return `${at}.verdict must be one of ${SELECTION_VERDICTS.join(", ")}`;
    }
    if (typeof entry.note !== "string") {
      return `${at}.note must be a string`;
    }
    if (entry.note.length > SELECTION_NOTE_MAX_LENGTH) {
      return `${at}.note must be at most ${SELECTION_NOTE_MAX_LENGTH} characters`;
    }
  }
  return null;
}

/** Copies only the known fields so stray properties never reach disk. */
function normalize(file: SelectionFile): SelectionFile {
  return {
    version: 1,
    entries: file.entries.map((e) => ({
      screen: e.screen,
      direction: e.direction,
      index: e.index,
      verdict: e.verdict,
      note: e.note,
    })),
  };
}

/**
 * Reads and validates a selection file. Never repairs or rewrites the file:
 * a malformed file raises `SelectionParseError` and stays byte-for-byte unchanged.
 * I/O errors such as ENOENT propagate unchanged so callers can tell "missing" from "malformed".
 */
export function readSelection(filePath: string): SelectionFile {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SelectionParseError(
      filePath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const reason = validateSelectionFile(parsed);
  if (reason) {
    throw new SelectionParseError(filePath, reason);
  }
  return normalize(parsed as SelectionFile);
}

/**
 * Validates `file`, then atomically replaces `filePath` (temp file in the same
 * directory, fsync, rename). Validation happens before any disk access, so a
 * rejected note leaves an existing file untouched (Req 1.10). An existing
 * malformed file is never overwritten (Req 1.12): the `SelectionParseError`
 * from reading it is thrown instead.
 */
export async function writeSelection(filePath: string, file: SelectionFile): Promise<void> {
  const invalid = validateSelectionFile(file);
  if (invalid) {
    throw new SelectionValidationError(invalid);
  }

  try {
    readSelection(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(tmp, "w");
    try {
      await handle.writeFile(`${JSON.stringify(normalize(file), null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    // Remove only our own temp file; the target is never touched before the rename.
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
