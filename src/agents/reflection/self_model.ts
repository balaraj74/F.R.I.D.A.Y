import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OperationalLesson, SelfModelConfig } from "./types.js";
import { embedText } from "../skills/retrieval/embedder.js";

const DEFAULT_CONFIG: SelfModelConfig = {
  maxEntries: 50,
  compactionThreshold: 60,
};

export async function getSelfModelPath(baseDir?: string): Promise<string> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  return path.join(dir, "self_model.jsonl");
}

export async function loadLessons(baseDir?: string): Promise<OperationalLesson[]> {
  const filePath = await getSelfModelPath(baseDir);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function recordLesson(
  lesson: Omit<OperationalLesson, "embedding">,
  baseDir?: string,
  config: SelfModelConfig = DEFAULT_CONFIG,
): Promise<void> {
  const filePath = await getSelfModelPath(baseDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const embedding = embedText(`${lesson.query} ${lesson.lesson}`);
  const fullLesson: OperationalLesson = {
    ...lesson,
    embedding,
  };

  const existing = await loadLessons(baseDir);
  existing.push(fullLesson);

  // Enforce bounded capacity to stay strictly bounded
  let finalLessons = existing;
  if (existing.length > config.maxEntries) {
    finalLessons = existing.slice(-config.maxEntries);
  }

  const output = finalLessons.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.writeFile(filePath, output, "utf-8");
}
