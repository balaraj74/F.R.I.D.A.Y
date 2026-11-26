import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { embedText, computeContentHash } from "./embedder.js";
import type { SkillEmbeddingEntry, SkillIndexStore } from "./types.js";

export const DEFAULT_INDEX_CACHE_PATH = path.join(
  os.homedir(),
  ".friday",
  "skills_embeddings.json",
);

/**
 * Loads the existing skill embedding store from disk if present.
 */
export function loadSkillIndexStore(filePath: string = DEFAULT_INDEX_CACHE_PATH): SkillIndexStore {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries) {
        return parsed as SkillIndexStore;
      }
    }
  } catch {
    // If corrupted or missing, start with a fresh store
  }

  return {
    version: 1,
    entries: {},
    lastIndexedAt: 0,
  };
}

/**
 * Saves the skill embedding store to disk.
 */
export function saveSkillIndexStore(
  store: SkillIndexStore,
  filePath: string = DEFAULT_INDEX_CACHE_PATH,
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempFile = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    // Non-fatal if cache write fails
    console.error(`[skills/indexer] Failed to persist skills index to ${filePath}:`, err);
  }
}

/**
 * Builds the text representation of a skill for embedding generation.
 */
export function buildSkillEmbeddingText(skill: Skill): string {
  const parts: string[] = [];
  parts.push(`Skill: ${skill.name}`);
  if (skill.description) {
    parts.push(`Description: ${skill.description}`);
  }
  // Include body content from file if available for contextual richness
  if (skill.filePath && fs.existsSync(skill.filePath)) {
    try {
      const content = fs.readFileSync(skill.filePath, "utf-8");
      const snippet = content.slice(0, 500).replace(/---[\s\S]*?---/, ""); // strip frontmatter
      if (snippet.trim()) {
        parts.push(`Context: ${snippet.trim()}`);
      }
    } catch {
      // Ignore file read error
    }
  }
  return parts.join("\n");
}

/**
 * Batch indexes a list of skills with incremental caching.
 */
export function indexSkills(
  skills: Skill[],
  options?: {
    cachePath?: string;
    forceReindex?: boolean;
  },
): SkillIndexStore {
  const cachePath = options?.cachePath ?? DEFAULT_INDEX_CACHE_PATH;
  const store = options?.forceReindex
    ? { version: 1, entries: {}, lastIndexedAt: 0 }
    : loadSkillIndexStore(cachePath);

  let updatedCount = 0;
  let reusedCount = 0;

  for (const skill of skills) {
    if (!skill.name) continue;

    const text = buildSkillEmbeddingText(skill);
    const hash = computeContentHash(text);
    const existing = store.entries[skill.name];

    if (
      !options?.forceReindex &&
      existing &&
      existing.hash === hash &&
      existing.embedding &&
      existing.embedding.length > 0
    ) {
      // Re-use existing embedding
      reusedCount++;
      continue;
    }

    // Generate new embedding
    const embedding = embedText(text);
    store.entries[skill.name] = {
      name: skill.name,
      description: skill.description || "",
      filePath: skill.filePath || "",
      hash,
      embedding,
      updatedAt: Date.now(),
    };
    updatedCount++;
  }

  store.lastIndexedAt = Date.now();
  saveSkillIndexStore(store, cachePath);

  return store;
}
