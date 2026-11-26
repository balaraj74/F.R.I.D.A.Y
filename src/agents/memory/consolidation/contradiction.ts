import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ConsolidatedFact, MemoryContradiction } from "./types.js";

interface ConflictRule {
  field: string;
  patternA: RegExp;
  patternB: RegExp;
  reason: string;
}

const CONFLICT_RULES: ConflictRule[] = [
  {
    field: "theme_preference",
    patternA: /(?:prefers?|likes?|uses?)\s+dark\s+theme/i,
    patternB: /(?:prefers?|likes?|uses?|switched to)\s+light\s+theme/i,
    reason: "Direct contradiction on UI theme preference (dark vs light)",
  },
  {
    field: "theme_preference_reverse",
    patternA: /(?:prefers?|likes?|uses?)\s+light\s+theme/i,
    patternB: /(?:prefers?|likes?|uses?|switched to)\s+dark\s+theme/i,
    reason: "Direct contradiction on UI theme preference (light vs dark)",
  },
  {
    field: "location",
    patternA: /location[:\s]+bengaluru/i,
    patternB: /(?:moved to|live in|relocated to)\s+(?!bengaluru|bangalore)[a-zA-Z\s]+/i,
    reason: "Contradiction on primary user location (Bengaluru vs new location)",
  },
  {
    field: "language_preference",
    patternA: /(?:always use|prefer)\s+python/i,
    patternB: /(?:never use|hate|dislike)\s+python/i,
    reason: "Direct contradiction on Python language preference",
  },
  {
    field: "language_preference_reverse",
    patternA: /(?:never use|hate|dislike)\s+python/i,
    patternB: /(?:always use|prefer)\s+python/i,
    reason: "Direct contradiction on Python language preference",
  },
  {
    field: "framework_stack",
    patternA:
      /(?:cinetra|darwina?)\s+(?:uses|architecture consists of|built with)\s+([a-zA-Z0-9_\-\s]+)/i,
    patternB: /(?:cinetra|darwina?)\s+switched\s+(?:stack|framework)\s+to\s+([a-zA-Z0-9_\-\s]+)/i,
    reason: "Contradiction on core project architectural stack",
  },
];

export function detectContradiction(
  newFact: ConsolidatedFact,
  existingDocText: string,
): MemoryContradiction | null {
  const newContent = newFact.content;

  for (const rule of CONFLICT_RULES) {
    // If existing text has patternA and new fact matches patternB (or vice-versa)
    const existingMatchesA = rule.patternA.test(existingDocText);
    const newMatchesB = rule.patternB.test(newContent);

    if (existingMatchesA && newMatchesB) {
      // Find matching snippet in existing text
      const lines = existingDocText.split("\n");
      const matchedLine =
        lines.find((l) => rule.patternA.test(l)) || "Existing statement in document";

      const conflictId = crypto
        .createHash("sha256")
        .update(`${rule.field}:${matchedLine}:${newContent}`)
        .digest("hex")
        .slice(0, 12);

      return {
        id: conflictId,
        existingFact: matchedLine.trim(),
        newFact: newContent.trim(),
        targetFile: newFact.targetFile,
        section: newFact.section,
        conflictReason: rule.reason,
        flaggedAt: Date.now(),
        status: "pending",
      };
    }
  }

  // Also check direct negation if both mention identical entity
  const matchNegation = newContent.match(
    /(?:never use|do not use|dislike|hate)\s+([a-zA-Z0-9_\-]+)/i,
  );
  if (matchNegation) {
    const term = matchNegation[1].toLowerCase();
    const positiveRegex = new RegExp(`(?:always use|prefers?|favorite)\\s+${term}`, "i");
    if (positiveRegex.test(existingDocText)) {
      const lines = existingDocText.split("\n");
      const matchedLine =
        lines.find((l) => positiveRegex.test(l)) || `Existing preference for ${term}`;
      return {
        id: crypto
          .createHash("sha256")
          .update(`${term}:${matchedLine}:${newContent}`)
          .digest("hex")
          .slice(0, 12),
        existingFact: matchedLine.trim(),
        newFact: newContent.trim(),
        targetFile: newFact.targetFile,
        section: newFact.section,
        conflictReason: `Direct opposition regarding '${term}' (positive preference vs negative statement)`,
        flaggedAt: Date.now(),
        status: "pending",
      };
    }
  }

  return null;
}

export async function persistContradictions(
  contradictions: MemoryContradiction[],
  storagePath: string,
): Promise<void> {
  if (contradictions.length === 0) return;

  let existing: MemoryContradiction[] = [];
  try {
    const raw = await fs.readFile(storagePath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }

  const existingIds = new Set(existing.map((c) => c.id));
  for (const c of contradictions) {
    if (!existingIds.has(c.id)) {
      existing.push(c);
      existingIds.add(c.id);
    }
  }

  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, JSON.stringify(existing, null, 2), "utf-8");
}
