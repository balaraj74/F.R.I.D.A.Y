// Finds new commitments in Sir's conversations with FRIDAY (HUD, WhatsApp self-chat) by reading
// session transcripts since the last scan and asking the fast brain to pull out promises and
// deadlines. Runs in the gateway every 20 minutes; only new lines are read.

import fs from "node:fs";
import path from "node:path";

import type { FRIDAYConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { fastComplete } from "../fast-brain.js";
import { commitmentsDir, type CommitmentOwner, upsertCommitment } from "./store.js";

const log = createSubsystemLogger("commitments");

const FIRST_SCAN_LOOKBACK_MS = 48 * 3600_000;
const MAX_CHARS_PER_CALL = 12_000;
// Sessions that are tests, evals or automation, not Sir talking.
const SKIP_SESSION_KEY = /eval|test|latency|cron:|subagent|heartbeat/i;

type Cursor = { files: Record<string, number>; initializedAt?: string };

export type ConversationLine = {
  role: "user" | "assistant";
  text: string;
  at: string;
  sessionKey: string;
};

function cursorPath(stateDir?: string) {
  return path.join(commitmentsDir(stateDir), "scan-cursor.json");
}

function loadCursor(stateDir?: string): Cursor | null {
  try {
    return JSON.parse(fs.readFileSync(cursorPath(stateDir), "utf-8")) as Cursor;
  } catch {
    return null;
  }
}

function saveCursor(cursor: Cursor, stateDir?: string) {
  const file = cursorPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cursor, null, 2), { mode: 0o600 });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}

/** Conversation lines worth reading: Sir's words and FRIDAY's replies, minus heartbeat noise and ids. */
export function conversationLines(
  jsonl: string,
  sessionKey: string,
  sinceMs = 0,
): ConversationLine[] {
  const out: ConversationLine[] = [];
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const at = entry.timestamp ?? "";
    if (sinceMs && Date.parse(at) < sinceMs) continue;
    let text = textOf(entry.message?.content)
      .replace(/\[message_id:[^\]]*\]/g, "")
      .trim();
    if (!text) continue;
    if (role === "user" && /HEARTBEAT|Read HEARTBEAT\.md/.test(text)) continue;
    if (role === "assistant" && /^HEARTBEAT_OK\b/.test(text)) continue;
    if (text.length > 1500) text = `${text.slice(0, 1500)}…`;
    out.push({ role, text, at, sessionKey });
  }
  return out;
}

const SYSTEM = `You extract commitments from a conversation between Sir (the user) and FRIDAY (his assistant).
A commitment is a concrete promise or obligation with a person or deadline, e.g. "I'll send Ravi the deck by Friday",
"Priya will share the numbers tomorrow", "remind me to pay rent on the 5th", or FRIDAY promising to do something later.
Ignore: general chat, questions, tasks FRIDAY already completed in the conversation, hypotheticals, and anything vague.
Return ONLY a JSON array (possibly empty). Each item:
{"text": short imperative of what must happen, "who": other person or null,
 "owner": "sir" (Sir must do it) | "other" (someone owes Sir) | "friday" (FRIDAY promised it),
 "due": ISO 8601 datetime with timezone offset or null, "dueText": deadline as said or null,
 "quote": the exact short phrase it came from, "confidence": 0..1}
Resolve relative dates ("Friday", "tomorrow evening") against the current time given. If only a day is given, use 18:00 local.`;

type Extracted = {
  text?: string;
  who?: string | null;
  owner?: string;
  due?: string | null;
  dueText?: string | null;
  quote?: string;
  confidence?: number;
};

export function parseExtraction(raw: string): Extracted[] {
  const start = raw.indexOf("[");
  if (start < 0) return [];
  const end = raw.lastIndexOf("]");
  if (end > start) {
    try {
      const arr = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch {
      // fall through to salvage
    }
  }
  // A reply cut off mid-array: keep every complete {...} item rather than losing them all.
  const out: Extracted[] = [];
  for (const m of raw.slice(start).matchAll(/\{[^{}]*\}/g)) {
    try {
      out.push(JSON.parse(m[0]));
    } catch {}
  }
  return out;
}

function nowContext(now: Date, timeZone: string) {
  const local = now.toLocaleString("en-GB", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Current time: ${local} (${timeZone}); ISO ${now.toISOString()}.`;
}

/** Ask the fast brain for commitments in these lines and store the confident ones. */
export async function extractCommitments(params: {
  cfg: FRIDAYConfig;
  lines: ConversationLine[];
  now?: Date;
  stateDir?: string;
  complete?: typeof fastComplete;
}): Promise<{ added: number; seen: number }> {
  const now = params.now ?? new Date();
  const timeZone =
    params.cfg.agents?.defaults?.heartbeat?.activeHours?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const complete = params.complete ?? fastComplete;
  let added = 0;
  let seen = 0;
  // Chunk by session so a quote always maps back to where it was said.
  const bySession = new Map<string, ConversationLine[]>();
  for (const l of params.lines)
    bySession.set(l.sessionKey, [...(bySession.get(l.sessionKey) ?? []), l]);
  for (const [sessionKey, lines] of bySession) {
    let chunk: string[] = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.some((l) => l.startsWith("Sir ["))) {
        chunk = [];
        size = 0;
        return;
      }
      const raw = await complete({
        cfg: params.cfg,
        system: SYSTEM,
        prompt: `${nowContext(now, timeZone)}\n\nConversation:\n${chunk.join("\n")}`,
        maxTokens: 6000,
        timeoutMs: 90_000,
      });
      chunk = [];
      size = 0;
      for (const item of parseExtraction(raw)) {
        seen++;
        if (!item.text || typeof item.text !== "string" || (item.confidence ?? 0) < 0.6) continue;
        const owner: CommitmentOwner =
          item.owner === "other" || item.owner === "friday" ? item.owner : "sir";
        const due =
          item.due && !Number.isNaN(Date.parse(item.due))
            ? new Date(item.due).toISOString()
            : undefined;
        const { created } = upsertCommitment(
          {
            text: item.text.trim().slice(0, 200),
            who: item.who?.trim() || undefined,
            owner,
            due,
            dueText: item.dueText?.trim() || undefined,
            source: {
              kind: "conversation",
              sessionKey,
              quote: item.quote?.slice(0, 200),
              at: now.toISOString(),
            },
          },
          { stateDir: params.stateDir, now },
        );
        if (created) added++;
      }
    };
    for (const l of lines) {
      const line = `${l.role === "user" ? "Sir" : "FRIDAY"} [${l.at.slice(0, 16)}]: ${l.text}`;
      if (size + line.length > MAX_CHARS_PER_CALL && chunk.length) await flush();
      chunk.push(line);
      size += line.length;
    }
    if (chunk.length) await flush();
  }
  return { added, seen };
}

/** Read new transcript lines since the last scan (first scan: last 48h) and extract commitments. */
export async function scanForCommitments(params: {
  cfg: FRIDAYConfig;
  sessionsDir: string;
  stateDir?: string;
  now?: Date;
  complete?: typeof fastComplete;
  /** Other extractors fed from the same new lines (knowledge graph). Failures are logged, not fatal. */
  alsoExtract?: (lines: ConversationLine[]) => Promise<unknown>;
}): Promise<{ added: number; seen: number; lines: number }> {
  const now = params.now ?? new Date();
  const cursor = loadCursor(params.stateDir) ?? { files: {}, initializedAt: now.toISOString() };
  const firstScan = !loadCursor(params.stateDir);
  let index: Record<string, { sessionId?: string }> = {};
  try {
    index = JSON.parse(fs.readFileSync(path.join(params.sessionsDir, "sessions.json"), "utf-8"));
  } catch {}
  const lines: ConversationLine[] = [];
  const nextFiles: Record<string, number> = { ...cursor.files };
  for (const [key, entry] of Object.entries(index)) {
    if (!entry?.sessionId || SKIP_SESSION_KEY.test(key)) continue;
    const file = path.join(params.sessionsDir, `${entry.sessionId}.jsonl`);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const from = cursor.files[entry.sessionId] ?? 0;
    if (size <= from) {
      nextFiles[entry.sessionId] = size;
      continue;
    }
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // Only consume complete lines; a half-written last line is read next time.
      const text = buf.toString("utf-8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) continue;
      lines.push(
        ...conversationLines(
          text.slice(0, lastNl + 1),
          key,
          from === 0 || firstScan ? now.getTime() - FIRST_SCAN_LOOKBACK_MS : 0,
        ),
      );
      nextFiles[entry.sessionId] = from + Buffer.byteLength(text.slice(0, lastNl + 1));
    } finally {
      fs.closeSync(fd);
    }
  }
  const result = lines.length
    ? await extractCommitments({
        cfg: params.cfg,
        lines,
        now,
        stateDir: params.stateDir,
        complete: params.complete,
      })
    : { added: 0, seen: 0 };
  if (lines.length && params.alsoExtract) {
    await params
      .alsoExtract(lines)
      .catch((err) => log.warn(`extra extraction failed: ${String(err)}`));
  }
  // Advance only after a successful extraction, so a model outage doesn't lose conversations.
  saveCursor({ ...cursor, files: nextFiles }, params.stateDir);
  if (result.added)
    log.info(`found ${result.added} new commitment(s) in ${lines.length} new lines`);
  return { ...result, lines: lines.length };
}

let running = false;

/** Scan every `everyMs` (default 20 min). Returns a stop function. */
export function startCommitmentScanSchedule(params: {
  cfg: () => FRIDAYConfig;
  sessionsDir: string;
  everyMs?: number;
  alsoExtract?: (cfg: FRIDAYConfig, lines: ConversationLine[]) => Promise<unknown>;
}): () => void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cfg = params.cfg();
      await scanForCommitments({
        cfg,
        sessionsDir: params.sessionsDir,
        alsoExtract: params.alsoExtract ? (lines) => params.alsoExtract!(cfg, lines) : undefined,
      });
    } catch (err) {
      log.warn(`scan failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, params.everyMs ?? 20 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
