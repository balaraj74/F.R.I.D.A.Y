// Autonomy kill switch (ROADMAP_V2 D5): one flag that pauses everything FRIDAY does on her own
// (heartbeat loop and scheduled jobs). Direct requests from Sir are unaffected.

import fsSync from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export type AutonomyState = { paused: boolean; changedAt?: number; reason?: string };

export function autonomyStateFile(): string {
  return path.join(resolveStateDir(), "autonomy.json");
}

export function readAutonomyState(file = autonomyStateFile()): AutonomyState {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf-8")) as Partial<AutonomyState>;
    return { paused: parsed.paused === true, changedAt: parsed.changedAt, reason: parsed.reason };
  } catch {
    return { paused: false };
  }
}

export function isAutonomyPaused(file = autonomyStateFile()): boolean {
  return readAutonomyState(file).paused;
}

export function setAutonomyPaused(
  paused: boolean,
  reason?: string,
  file = autonomyStateFile(),
): AutonomyState {
  const next: AutonomyState = { paused, changedAt: Date.now(), ...(reason ? { reason } : {}) };
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fsSync.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  fsSync.renameSync(tmp, file);
  return next;
}
