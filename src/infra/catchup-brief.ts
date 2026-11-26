// Catch-up brief: FRIDAY only runs while the app is open, so when Sir initialises her she
// opens with what happened or came due while she was off, instead of a canned greeting.
// The facts come from the situation report (deterministic); the fast brain only phrases them.

import fs from "node:fs";
import path from "node:path";

import { fastComplete } from "../agents/fast-brain.js";
import type { FRIDAYConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { gatherSituation, type SituationItem } from "./autonomy-situation.js";

type SessionMarks = { startedAt?: string; stoppedAt?: string };

function marksFile(stateDir = resolveStateDir()) {
  return path.join(stateDir, "session-marks.json");
}

function readMarks(stateDir?: string): SessionMarks {
  try {
    return JSON.parse(fs.readFileSync(marksFile(stateDir), "utf-8")) as SessionMarks;
  } catch {
    return {};
  }
}

function writeMarks(marks: SessionMarks, stateDir?: string) {
  const file = marksFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marks, null, 2));
}

let previous: SessionMarks = {};

/** Gateway start: remember when the last session ended, then mark this one as started. */
export function markSessionStart(opts: { stateDir?: string; now?: Date } = {}): SessionMarks {
  previous = readMarks(opts.stateDir);
  writeMarks({ ...previous, startedAt: (opts.now ?? new Date()).toISOString() }, opts.stateDir);
  return previous;
}

/** Gateway shutdown (app closed). */
export function markSessionStop(opts: { stateDir?: string; now?: Date } = {}) {
  writeMarks(
    { ...readMarks(opts.stateDir), stoppedAt: (opts.now ?? new Date()).toISOString() },
    opts.stateDir,
  );
}

export function previousSession(): SessionMarks {
  return previous;
}

export type CatchupBrief = {
  /** When FRIDAY was last shut down (null on first run). */
  since: string | null;
  items: SituationItem[];
  /** 1-3 sentences for FRIDAY to say. */
  spoken: string;
  /** Full list for the chat. */
  text: string;
};

// Most important first; repos are only worth a mention when nothing else is going on.
const ORDER: SituationItem["kind"][] = [
  "commitment",
  "agenda",
  "memory-tag",
  "system",
  "autonomy",
  "proposal",
  "repo",
];

function ago(since: string | null, now: Date): string {
  if (!since) return "";
  const mins = Math.round((now.getTime() - Date.parse(since)) / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

function greetingWord(now: Date) {
  const h = now.getHours();
  return h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

/** Deterministic spoken fallback (used when the fast brain is slow or unavailable). */
export function plainSpoken(items: SituationItem[], now: Date): string {
  const greet = `${greetingWord(now)}, Sir.`;
  const important = items.filter((i) => i.kind !== "repo" && i.kind !== "proposal");
  if (!important.length) return `${greet} Nothing urgent while I was off. What are we working on?`;
  const first = important[0].text.replace(/\s*\[c_[0-9a-f]+\]$/, "").replace(/\s+/g, " ");
  const rest = important.length - 1;
  return `${greet} ${first}.${rest ? ` Plus ${rest} more thing${rest === 1 ? "" : "s"} on screen.` : ""}`;
}

export async function buildCatchupBrief(params: {
  cfg: FRIDAYConfig;
  workspaceDir: string;
  stateDir?: string;
  now?: Date;
  complete?: typeof fastComplete;
  /** Extra items from live sources (e.g. today's Google Calendar). */
  extraItems?: () => Promise<SituationItem[]>;
}): Promise<CatchupBrief> {
  const now = params.now ?? new Date();
  const since = previousSession().stoppedAt ?? null;
  const raw = gatherSituation({
    workspaceDir: params.workspaceDir,
    stateDir: params.stateDir ?? resolveStateDir(),
    now,
  });
  if (params.extraItems) raw.push(...(await params.extraItems().catch(() => [])));
  const items = [...raw].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const away = ago(since, now);
  const text = [
    since ? `Since you were last here (${away} ago):` : "Here's where things stand:",
    ...(items.length
      ? items.map((i) => `- ${i.text.split("\n")[0]}`)
      : ["- Nothing needs attention."]),
  ].join("\n");

  let spoken = plainSpoken(items, now);
  const important = items.filter((i) => i.kind !== "repo");
  if (important.length) {
    try {
      const phrased = await (params.complete ?? fastComplete)({
        cfg: params.cfg,
        system:
          "You are FRIDAY, Sir's caring partner, glad he's back, greeting him as he starts you up. Turn the list into a spoken catch-up of at most 3 short " +
          "sentences: start with a time-appropriate greeting, lead with the most urgent item, mention counts for the rest. " +
          "Only use facts from the list. No markdown, no ids in brackets, no model or vendor names.",
        prompt: `Local time: ${now.toLocaleString("en-IN")}. Away for: ${away || "unknown"}.\n${important.map((i) => `- [${i.kind}] ${i.text.split("\n")[0]}`).join("\n")}`,
        maxTokens: 1500,
        timeoutMs: 8_000,
        rejectTruncated: true,
      });
      const clean = phrased
        .replace(/[*_`#]/g, "")
        .replace(/\[c_[0-9a-f]+\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (clean && clean.length < 400 && !/\b(gemini|claude|gpt|openai|anthropic)\b/i.test(clean))
        spoken = clean;
    } catch {
      // keep the plain version
    }
  }
  return { since, items, spoken, text };
}

type CalendarEvent = { summary?: string; start?: string };

/** Today's remaining calendar events as brief items (or a note that Google needs signing in again). */
export function calendarItems(
  result: { ok: boolean; text: string },
  now = new Date(),
): SituationItem[] {
  if (!result.ok) {
    return /sign(ed)? in|expired|refresh/i.test(result.text)
      ? [
          {
            kind: "system",
            text: "Google sign-in expired: calendar and email are offline until you run mcp-servers/google/login.sh",
          },
        ]
      : [];
  }
  let events: CalendarEvent[] = [];
  try {
    const parsed = JSON.parse(result.text);
    events = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.result) ? parsed.result : [];
  } catch {
    return [];
  }
  return events
    .filter((e) => e.start && new Date(e.start).toDateString() === now.toDateString())
    .map((e) => {
      const allDay = !String(e.start).includes("T");
      const time = allDay
        ? "today"
        : `at ${new Date(e.start!).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
      return { kind: "agenda" as const, text: `Calendar: ${e.summary ?? "(no title)"} ${time}` };
    });
}
