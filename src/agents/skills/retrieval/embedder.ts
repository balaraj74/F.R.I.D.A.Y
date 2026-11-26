import crypto from "node:crypto";

export const EMBEDDING_DIMENSION = 384;

const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

/**
 * Deterministic hash function mapping string tokens to dimension index & sign.
 */
function hashToken(token: string, seed: number = 0): { index: number; sign: number } {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const index = Math.abs(h) % EMBEDDING_DIMENSION;
  const sign = (h & 1) === 0 ? 1.0 : -1.0;
  return { index, sign };
}

const ACRONYMS: Record<string, string[]> = {
  pr: ["pull", "request"],
  prs: ["pull", "request", "requests"],
  pull: ["pr", "pullrequest"],
  git: ["github", "version", "control", "repository", "commit"],
  gh: ["github", "git"],
  repo: ["repository", "github"],
  commit: ["git", "github"],
  db: ["database", "sql"],
  sql: ["database", "postgres", "mysql"],
  k8s: ["kubernetes"],
  vm: ["virtual", "machine"],
  ci: ["continuous", "integration", "workflow", "run"],
  cd: ["continuous", "deployment"],
  ec2: ["aws", "cloud", "instance"],
  s3: ["aws", "storage", "bucket"],
  api: ["endpoint", "interface", "rest"],
  tts: ["audio", "speech", "voice"],
  audio: ["whisper", "sound", "voice", "speech", "transcribe"],
  transcribe: ["whisper", "audio", "speech"],
  whisper: ["audio", "transcribe", "speech"],
  order: ["ordercli", "food", "delivery", "restaurant"],
  food: ["ordercli", "order", "delivery", "restaurant"],
  reminder: ["reminders", "apple-reminders", "task"],
  reminders: ["apple-reminders", "reminder", "task"],
  note: ["notes", "apple-notes", "bear-notes"],
  notes: ["note", "apple-notes", "bear-notes"],
  chat: ["slack", "discord", "message"],
  message: ["slack", "discord", "imsg"],
  messages: ["slack", "discord", "imsg"],
};

/**
 * Tokenizes text into word tokens and subword character n-grams.
 */
export function extractFeatures(text: string): Map<string, number> {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9_\-\s]/g, " ");
  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  const features = new Map<string, number>();

  for (const word of rawWords) {
    if (STOP_WORDS.has(word) || word.length < 2) continue;

    // Full word feature (higher weight)
    const currentWeight = features.get(word) ?? 0;
    features.set(word, currentWeight + 2.0);

    // Expand common acronyms
    const expanded = ACRONYMS[word];
    if (expanded) {
      for (const exp of expanded) {
        features.set(exp, (features.get(exp) ?? 0) + 1.5);
      }
    }

    // Subword character 3-grams and 4-grams (lower weight for typo / morphology tolerance)
    if (word.length >= 3) {
      for (let i = 0; i <= word.length - 3; i++) {
        const tri = `_${word.slice(i, i + 3)}`;
        features.set(tri, (features.get(tri) ?? 0) + 0.5);
      }
    }
    if (word.length >= 5) {
      for (let i = 0; i <= word.length - 4; i++) {
        const quad = `__${word.slice(i, i + 4)}`;
        features.set(quad, (features.get(quad) ?? 0) + 0.3);
      }
    }
  }

  return features;
}

/**
 * Generates an L2-normalized dense embedding vector (dimension = EMBEDDING_DIMENSION).
 */
export function embedText(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIMENSION);
  const features = extractFeatures(text);

  if (features.size === 0) {
    return Array.from(vec);
  }

  for (const [feature, count] of features.entries()) {
    // Sublinear term frequency scaling
    const weight = 1.0 + Math.log(count);

    // Hash into primary index
    const { index: idx1, sign: sign1 } = hashToken(feature, 1337);
    vec[idx1] += sign1 * weight;

    // Dual-hash to reduce collision clustering
    const { index: idx2, sign: sign2 } = hashToken(feature, 7919);
    vec[idx2] += sign2 * weight * 0.5;
  }

  // Calculate L2 norm
  let normSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    normSq += vec[i] * vec[i];
  }

  if (normSq <= 1e-12) {
    return Array.from(vec);
  }

  const invNorm = 1.0 / Math.sqrt(normSq);
  const normalized = new Array<number>(EMBEDDING_DIMENSION);
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    normalized[i] = Number((vec[i] * invNorm).toFixed(6));
  }

  return normalized;
}

/**
 * Computes cosine similarity between two L2-normalized embedding vectors.
 * Since vectors are pre-normalized, cosine similarity is simply the dot product.
 */
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0.0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Clamp to [-1.0, 1.0] to guard against floating-point imprecision
  return Math.max(-1.0, Math.min(1.0, dot));
}

/**
 * Computes a SHA-256 content hash for change detection / incremental caching.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}
