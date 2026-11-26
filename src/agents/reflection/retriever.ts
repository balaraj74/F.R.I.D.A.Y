import type { OperationalLesson } from "./types.js";
import { loadLessons } from "./self_model.js";
import { embedText, computeCosineSimilarity } from "../skills/retrieval/embedder.js";

export async function retrieveRelevantLessons(params: {
  query: string;
  topK?: number;
  baseDir?: string;
  minScore?: number;
}): Promise<{ lessons: OperationalLesson[]; prompt: string }> {
  const topK = params.topK ?? 3;
  const minScore = params.minScore ?? 0.1;
  const lessons = await loadLessons(params.baseDir);

  if (lessons.length === 0 || !params.query.trim()) {
    return { lessons: [], prompt: "" };
  }

  const queryVec = embedText(params.query);
  const qWords = params.query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);

  const scored: Array<{ lesson: OperationalLesson; score: number }> = [];

  for (const item of lessons) {
    let score = 0;
    if (item.embedding && item.embedding.length === queryVec.length) {
      score = computeCosineSimilarity(queryVec, item.embedding);
    } else {
      const itemVec = embedText(`${item.query} ${item.lesson}`);
      score = computeCosineSimilarity(queryVec, itemVec);
    }

    // Keyword overlap boost
    const itemText = `${item.query} ${item.lesson}`.toLowerCase();
    for (const w of qWords) {
      if (itemText.includes(w)) {
        score += 0.2;
      }
    }

    if (score >= minScore) {
      scored.push({ lesson: item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK).map((s) => s.lesson);

  if (top.length === 0) {
    return { lessons: [], prompt: "" };
  }

  const promptLines = [
    "<reflective_lessons>",
    "Operational insights from previous similar tasks:",
    ...top.map((l) => `- ${l.lesson}`),
    "</reflective_lessons>",
  ];

  return {
    lessons: top,
    prompt: promptLines.join("\n"),
  };
}
