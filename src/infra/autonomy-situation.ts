// Situation report for the autonomy loop (ROADMAP_V2 D2). Deterministic and cheap: no model
// calls. The heartbeat reads it first and only spends a model turn acting when something
// actually needs attention.

import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  attentionCommitments,
  describeCommitment,
  loadCommitments,
} from "../agents/commitments/store.js";
import { loadTrust, morningBrief } from "./autonomy-trust.js";

export type SituationItem = {
  kind: "agenda" | "commitment" | "memory-tag" | "repo" | "system" | "proposal" | "autonomy";
  text: string;
};

const TAG = /\[(REMIND|URGENT|FOLLOW-UP)\]/i;
const DONE = /\[x\]/i;
// `[REMIND]` in backticks is a legend/definition line, not an open reminder.
const TAG_DEFINITION = /`\[(REMIND|URGENT|FOLLOW-UP)\]`/i;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Agenda items starting within `withinMin` minutes (or already started) and not completed. */
export function dueAgenda(
  agenda: Array<{ time?: string; title?: string; completed?: boolean }>,
  now: Date,
  withinMin = 120,
): SituationItem[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return agenda
    .filter((a) => !a.completed && typeof a.time === "string" && /^\d{1,2}:\d{2}$/.test(a.time))
    .map((a) => {
      const [h, m] = a.time!.split(":").map(Number);
      return { a, delta: h * 60 + m - nowMin };
    })
    .filter(({ delta }) => delta >= -60 && delta <= withinMin)
    .map(({ a, delta }) => ({
      kind: "agenda" as const,
      text:
        delta >= 0
          ? `${a.title} at ${a.time} (in ${delta} min)`
          : `${a.title} started at ${a.time}, not marked done`,
    }));
}

/** Open [REMIND]/[URGENT]/[FOLLOW-UP] lines in curated memory. */
export function openMemoryTags(
  files: Array<{ name: string; content: string }>,
  limit = 8,
): SituationItem[] {
  const out: SituationItem[] = [];
  for (const f of files) {
    for (const line of f.content.split("\n")) {
      if (TAG.test(line) && !DONE.test(line) && !TAG_DEFINITION.test(line))
        out.push({ kind: "memory-tag", text: `${f.name}: ${line.trim().slice(0, 160)}` });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Parse `git status -sb --porcelain`. Unpushed/behind is actionable and reported per repo;
 * uncommitted work is only counted (it is often long-lived and is never FRIDAY's to commit).
 */
export function repoStatus(porcelain: string): {
  uncommitted: number;
  ahead: number;
  behind: number;
} {
  const [header = "", ...rest] = porcelain.split("\n");
  return {
    uncommitted: rest.filter((l) => l.trim()).length,
    ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
  };
}

export function repoItems(repos: Array<{ name: string; porcelain: string }>): SituationItem[] {
  const items: SituationItem[] = [];
  const dirty: string[] = [];
  for (const { name, porcelain } of repos) {
    const st = repoStatus(porcelain);
    const parts = [
      st.ahead ? `${st.ahead} unpushed commit${st.ahead === 1 ? "" : "s"}` : "",
      st.behind ? `${st.behind} behind remote` : "",
    ].filter(Boolean);
    if (parts.length) items.push({ kind: "repo", text: `${name}: ${parts.join(", ")}` });
    if (st.uncommitted) dirty.push(name);
  }
  if (dirty.length) {
    items.push({
      kind: "repo",
      text: `Uncommitted work in ${dirty.length} repo(s): ${dirty.join(", ")} (informational)`,
    });
  }
  return items;
}

function discoverRepos(home: string, max = 20): string[] {
  const repos: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (repos.length >= max || depth > 2) return;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      repos.push(dir);
      return;
    }
    for (const e of entries) {
      if (
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        e.name !== "node_modules" &&
        e.name !== "snap"
      ) {
        visit(path.join(dir, e.name), depth + 1);
      }
    }
  };
  visit(home, 0);
  return repos;
}

function systemItems(): SituationItem[] {
  const items: SituationItem[] = [];
  try {
    const pct = Number(
      /(\d+)%/.exec(
        execFileSync("df", ["--output=pcent", "/"], { encoding: "utf-8", timeout: 3000 }),
      )?.[1],
    );
    if (pct >= 90) items.push({ kind: "system", text: `Disk ${pct}% full` });
  } catch {}
  try {
    const mem = fsSync.readFileSync("/proc/meminfo", "utf-8");
    const total = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1]);
    const avail = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]);
    if (total && avail / total < 0.1)
      items.push({ kind: "system", text: `RAM low: ${Math.round(avail / 1024)} MB available` });
  } catch {}
  try {
    for (const bat of fsSync
      .readdirSync("/sys/class/power_supply")
      .filter((d) => d.startsWith("BAT"))) {
      const cap = Number(fsSync.readFileSync(`/sys/class/power_supply/${bat}/capacity`, "utf-8"));
      const status = fsSync.readFileSync(`/sys/class/power_supply/${bat}/status`, "utf-8").trim();
      if (cap <= 20 && status === "Discharging")
        items.push({ kind: "system", text: `Battery ${cap}% and discharging` });
    }
  } catch {}
  return items;
}

export function gatherSituation(params: {
  workspaceDir: string;
  stateDir: string;
  now?: Date;
  repos?: string[];
}): SituationItem[] {
  const now = params.now ?? new Date();
  const items: SituationItem[] = [];

  const agenda = readJson<{
    agenda?: Array<{ time?: string; title?: string; completed?: boolean }>;
  }>(path.join(params.stateDir, "agenda.json"));
  items.push(...dueAgenda(agenda?.agenda ?? [], now));

  for (const c of attentionCommitments(loadCommitments(params.stateDir), now)) {
    items.push({ kind: "commitment", text: describeCommitment(c, now) });
  }

  const memFiles: Array<{ name: string; content: string }> = [];
  for (const rel of ["MEMORY.md", "HEARTBEAT.md"]) {
    try {
      memFiles.push({
        name: rel,
        content: fsSync.readFileSync(path.join(params.workspaceDir, rel), "utf-8"),
      });
    } catch {}
  }
  try {
    const dir = path.join(params.workspaceDir, "memory");
    for (const f of fsSync
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort()
      .slice(-14)) {
      memFiles.push({
        name: `memory/${f}`,
        content: fsSync.readFileSync(path.join(dir, f), "utf-8"),
      });
    }
  } catch {}
  items.push(...openMemoryTags(memFiles));

  const repoStates: Array<{ name: string; porcelain: string }> = [];
  for (const repo of params.repos ?? discoverRepos(os.homedir())) {
    try {
      const porcelain = execFileSync("git", ["-C", repo, "status", "-sb", "--porcelain"], {
        encoding: "utf-8",
        timeout: 4000,
      });
      repoStates.push({ name: path.basename(repo), porcelain });
    } catch {}
  }
  items.push(...repoItems(repoStates));

  items.push(...systemItems());

  // Morning brief: once a day (from 08:00), what FRIDAY did on her own since the last brief.
  const lastBrief = loadTrust(params.stateDir).lastBriefAt;
  const briefDue =
    now.getHours() >= 8 &&
    (!lastBrief || new Date(lastBrief).toDateString() !== now.toDateString());
  if (briefDue) {
    const brief = morningBrief({ stateDir: params.stateDir, now });
    if (brief.count) {
      items.push({
        kind: "autonomy",
        text: `${brief.text}
Send Sir this brief (short), then run: friday trust brief --sent`,
      });
    }
  }

  try {
    const dir = path.join(params.stateDir, "memory", "proposals");
    for (const day of fsSync.readdirSync(dir)) {
      if (!fsSync.existsSync(path.join(dir, day, "APPLIED"))) {
        items.push({
          kind: "proposal",
          text: `Memory consolidation proposal ${day} awaiting review (${path.join(dir, day, "REVIEW.md")})`,
        });
      }
    }
  } catch {}
  return items;
}

export function formatSituation(items: SituationItem[], now = new Date()): string {
  if (items.length === 0) return `Situation ${now.toLocaleString()}: nothing needs attention.`;
  const order: SituationItem["kind"][] = [
    "agenda",
    "commitment",
    "memory-tag",
    "system",
    "autonomy",
    "repo",
    "proposal",
  ];
  const titles: Record<SituationItem["kind"], string> = {
    agenda: "Agenda",
    commitment: "Commitments due (overdue / next 3h / today)",
    autonomy: "Autonomous actions to report",
    "memory-tag": "Open reminders",
    system: "System",
    repo: "Repos",
    proposal: "Memory proposals",
  };
  const lines = [`Situation ${now.toLocaleString()}:`];
  for (const kind of order) {
    const group = items.filter((i) => i.kind === kind);
    if (group.length) lines.push(`${titles[kind]}:`, ...group.map((i) => `- ${i.text}`));
  }
  return lines.join("\n");
}
