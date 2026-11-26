import type { Skill } from "@earendil-works/pi-coding-agent";
import { embedText, computeCosineSimilarity } from "./embedder.js";
import { indexSkills, loadSkillIndexStore } from "./indexer.js";
import type { SkillRetrievalResult } from "./types.js";

export const DEFAULT_TOP_K = 8;
export const MIN_TOP_K = 5;
export const MAX_TOP_K = 10;

export type RetrieveSkillsOptions = {
  query: string;
  context?: string;
  candidates: Skill[];
  topK?: number;
  minScore?: number;
  cachePath?: string;
};

/**
 * Retrieves the top 5-10 skills most relevant to the query and recent context
 * using cosine similarity over precomputed description embeddings.
 */
export function retrieveSkills(options: RetrieveSkillsOptions): SkillRetrievalResult {
  const { query, context, candidates, cachePath } = options;
  const totalSkills = candidates.length;

  if (totalSkills === 0) {
    return {
      skills: [],
      scores: {},
      totalSkills: 0,
      retrievedCount: 0,
    };
  }

  const requestedK = options.topK ?? DEFAULT_TOP_K;
  const targetK = Math.min(Math.max(requestedK, MIN_TOP_K), Math.min(MAX_TOP_K, totalSkills));
  const minScore = options.minScore ?? 0.0;

  // Ensure index is populated
  const index = indexSkills(candidates, { cachePath });

  // Build combined search query: query + recent context
  const combinedText = [query.trim(), context ? context.slice(-400).trim() : ""]
    .filter(Boolean)
    .join("\n");

  const queryVec = embedText(combinedText);
  const normalizedQueryLower = query.toLowerCase();

  const scored: Array<{ skill: Skill; score: number }> = [];
  const scoreMap: Record<string, number> = {};

  for (const skill of candidates) {
    const entry = index.entries[skill.name];
    let score = 0.0;

    if (entry && entry.embedding && entry.embedding.length > 0) {
      score = computeCosineSimilarity(queryVec, entry.embedding);
    }

    // Direct name mention bonus: if the user explicitly names the skill or CLI (e.g. "github", "gh", "weather")
    const skillNameLower = skill.name.toLowerCase();
    if (
      normalizedQueryLower.includes(skillNameLower) ||
      (skill.name.includes("-") &&
        normalizedQueryLower.includes(skillNameLower.replaceAll("-", " ")))
    ) {
      score = Math.max(score, 0.4) + 0.35;
    }

    scored.push({ skill, score });
    scoreMap[skill.name] = Number(score.toFixed(4));
  }

  // Sort descending by relevance score
  scored.sort((a, b) => b.score - a.score);

  // Filter by minScore, but ensure at least MIN_TOP_K skills are returned if available
  let selected = scored.filter((item) => item.score >= minScore);
  if (selected.length < targetK) {
    selected = scored.slice(0, targetK);
  } else {
    selected = selected.slice(0, targetK);
  }

  const resultSkills = selected.map((item) => item.skill);

  return {
    skills: resultSkills,
    scores: scoreMap,
    totalSkills,
    retrievedCount: resultSkills.length,
  };
}
