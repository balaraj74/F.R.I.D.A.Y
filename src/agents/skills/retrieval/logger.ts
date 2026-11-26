import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SkillRetrievalLogEntry } from "./types.js";

export const DEFAULT_LOG_PATH = path.join(os.homedir(), ".friday", "logs", "skill_retrieval.jsonl");

/**
 * Appends a skill retrieval telemetry entry to the JSONL log file.
 */
export function logSkillRetrieval(entry: {
  runId?: string;
  sessionId?: string;
  query: string;
  retrievedSkills: string[];
  invokedSkills: string[];
  logPath?: string;
}): SkillRetrievalLogEntry {
  const logPath = entry.logPath ?? DEFAULT_LOG_PATH;
  const retrievedSet = new Set(entry.retrievedSkills);

  // A hit occurs if any invoked skill was in the retrieved set (or if no skill was invoked)
  const hit =
    entry.invokedSkills.length === 0 || entry.invokedSkills.some((s) => retrievedSet.has(s));

  const record: SkillRetrievalLogEntry = {
    timestamp: Date.now(),
    runId: entry.runId,
    sessionId: entry.sessionId,
    query: entry.query.slice(0, 300),
    retrievedSkills: entry.retrievedSkills,
    invokedSkills: entry.invokedSkills,
    hit,
  };

  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.error(`[skills/retrieval/logger] Failed to append retrieval log:`, err);
  }

  return record;
}

/**
 * Analyzes the skill retrieval log to measure retrieval accuracy and identify dead skills.
 */
export function analyzeSkillRetrieval(options?: { logPath?: string; allSkillNames?: string[] }): {
  totalTurns: number;
  totalInvocations: number;
  hitCount: number;
  accuracyRate: number;
  retrievalFrequency: Record<string, number>;
  invocationFrequency: Record<string, number>;
  deadSkills: string[];
} {
  const logPath = options?.logPath ?? DEFAULT_LOG_PATH;
  const allSkills = new Set(options?.allSkillNames ?? []);

  let totalTurns = 0;
  let totalInvocations = 0;
  let hitCount = 0;

  const retrievalFreq: Record<string, number> = {};
  const invocationFreq: Record<string, number> = {};

  if (fs.existsSync(logPath)) {
    const lines = fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) {
      try {
        const item: SkillRetrievalLogEntry = JSON.parse(line);
        totalTurns++;

        for (const s of item.retrievedSkills) {
          retrievalFreq[s] = (retrievalFreq[s] ?? 0) + 1;
        }

        if (item.invokedSkills && item.invokedSkills.length > 0) {
          totalInvocations += item.invokedSkills.length;
          for (const s of item.invokedSkills) {
            invocationFreq[s] = (invocationFreq[s] ?? 0) + 1;
          }
        }

        if (item.hit) {
          hitCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  const deadSkills = Array.from(allSkills).filter(
    (skill) => !retrievalFreq[skill] && !invocationFreq[skill],
  );

  return {
    totalTurns,
    totalInvocations,
    hitCount,
    accuracyRate: totalTurns > 0 ? Number((hitCount / totalTurns).toFixed(4)) : 1.0,
    retrievalFrequency: retrievalFreq,
    invocationFrequency: invocationFreq,
    deadSkills,
  };
}
