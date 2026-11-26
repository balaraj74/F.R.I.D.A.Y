// Commitments: promises and deadlines FRIDAY should keep track of for Sir ("I'll send Ravi the
// deck by Friday", "Priya will share the numbers tomorrow"). Stored locally as JSON under the
// state dir; nothing leaves the machine except the extraction call to the fast model.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

export type CommitmentOwner = "sir" | "other" | "friday";
export type CommitmentStatus = "open" | "done" | "dismissed";

export type Commitment = {
  id: string;
  /** What has to happen, as a short imperative ("Send the deck to Ravi"). */
  text: string;
  /** The other person involved, if any. */
  who?: string;
  /** Who owes it: Sir, someone else (Sir is waiting on them), or FRIDAY herself. */
  owner: CommitmentOwner;
  /** Deadline (ISO), when one was stated or clearly implied. */
  due?: string;
  /** The deadline as said ("by Friday"). */
  dueText?: string;
  status: CommitmentStatus;
  source: { kind: "conversation" | "manual"; sessionKey?: string; quote?: string; at: string };
  createdAt: string;
  updatedAt: string;
  snoozedUntil?: string;
};

type StoreFile = { version: 1; commitments: Commitment[] };

export function commitmentsDir(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "commitments");
}

function storePath(stateDir?: string) {
  return path.join(commitmentsDir(stateDir), "commitments.json");
}

export function loadCommitments(stateDir?: string): Commitment[] {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(stateDir), "utf-8")) as StoreFile;
    return Array.isArray(data.commitments) ? data.commitments : [];
  } catch {
    return [];
  }
}

export function saveCommitments(list: Commitment[], stateDir?: string): void {
  const file = storePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, commitments: list } satisfies StoreFile, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  fs.renameSync(tmp, file);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "will",
  "his",
  "her",
  "him",
  "sir",
  "send",
  "get",
]);

export function similarity(a: string, b: string): number {
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

export type NewCommitment = Omit<Commitment, "id" | "status" | "createdAt" | "updatedAt">;

/** Add a commitment unless an open one already covers it (then fill in a missing deadline). */
export function upsertCommitment(
  input: NewCommitment,
  opts: { stateDir?: string; now?: Date } = {},
): { commitment: Commitment; created: boolean } {
  const now = (opts.now ?? new Date()).toISOString();
  const list = loadCommitments(opts.stateDir);
  const sameWho = (c: Commitment) =>
    !c.who || !input.who || c.who.toLowerCase() === input.who.toLowerCase();
  const existing = list.find(
    (c) => c.status === "open" && sameWho(c) && similarity(c.text, input.text) >= 0.6,
  );
  if (existing) {
    if (!existing.due && input.due) {
      existing.due = input.due;
      existing.dueText = input.dueText;
      existing.updatedAt = now;
      saveCommitments(list, opts.stateDir);
    }
    return { commitment: existing, created: false };
  }
  const commitment: Commitment = {
    ...input,
    id: `c_${crypto.randomBytes(3).toString("hex")}`,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  list.push(commitment);
  saveCommitments(list, opts.stateDir);
  return { commitment, created: true };
}

export function updateCommitment(
  id: string,
  patch: Partial<Pick<Commitment, "status" | "due" | "dueText" | "snoozedUntil" | "text">>,
  opts: { stateDir?: string; now?: Date } = {},
): Commitment | null {
  const list = loadCommitments(opts.stateDir);
  const c = list.find((x) => x.id === id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: (opts.now ?? new Date()).toISOString() });
  saveCommitments(list, opts.stateDir);
  return c;
}

export type DueBucket = "overdue" | "soon" | "today" | "week" | "later" | "undated";

/** Where an open commitment stands relative to now (local time for "today"). */
export function dueBucket(c: Commitment, now = new Date()): DueBucket {
  if (!c.due) return "undated";
  const due = new Date(c.due).getTime();
  if (Number.isNaN(due)) return "undated";
  const diff = due - now.getTime();
  if (diff < 0) return "overdue";
  if (diff <= 3 * 3600_000) return "soon";
  if (new Date(due).toDateString() === now.toDateString()) return "today";
  if (diff <= 7 * 86400_000) return "week";
  return "later";
}

/** Open commitments that need Sir's attention now: overdue, due within 3h, or due later today. */
export function attentionCommitments(
  list: Commitment[],
  now = new Date(),
): Array<Commitment & { bucket: DueBucket }> {
  return list
    .filter((c) => c.status === "open" && !(c.snoozedUntil && new Date(c.snoozedUntil) > now))
    .map((c) => ({ ...c, bucket: dueBucket(c, now) }))
    .filter((c) => c.bucket === "overdue" || c.bucket === "soon" || c.bucket === "today")
    .sort((a, b) => new Date(a.due!).getTime() - new Date(b.due!).getTime());
}

export function describeCommitment(c: Commitment, now = new Date()): string {
  const who =
    c.owner === "other"
      ? `${c.who ?? "Someone"} owes Sir: `
      : c.owner === "friday"
        ? "FRIDAY: "
        : c.who
          ? `For ${c.who}: `
          : "";
  let when = "";
  if (c.due) {
    const d = new Date(c.due);
    const bucket = dueBucket(c, now);
    const time = d.toLocaleString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    when = bucket === "overdue" ? ` (OVERDUE since ${time})` : ` (due ${time})`;
  } else if (c.dueText) {
    when = ` (${c.dueText})`;
  }
  return `${who}${c.text}${when} [${c.id}]`;
}
