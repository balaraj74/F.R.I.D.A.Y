import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ConsolidatedFact, FactCategory } from "./types.js";

const PREFERENCE_PATTERNS = [
  /i prefer\s+([^.,;\n]+)/i,
  /my favorite\s+([^.,;\n]+)/i,
  /always use\s+([^.,;\n]+)/i,
  /never use\s+([^.,;\n]+)/i,
  /please remember (?:that )?([^.,;\n]+)/i,
  /i switched to\s+([^.,;\n]+)/i,
  /i dislike\s+([^.,;\n]+)/i,
  /i hate\s+([^.,;\n]+)/i,
  /i love\s+([^.,;\n]+)/i,
  /my new\s+([a-zA-Z0-9_\-\s]+)\s+is\s+([^.,;\n]+)/i,
];

const SYSTEM_PATTERNS = [
  /configured (?:the )?([a-zA-Z0-9_\-]+) to\s+([^.,;\n]+)/i,
  /deployed (?:the )?([a-zA-Z0-9_\-]+) on\s+([^.,;\n]+)/i,
  /installed ([a-zA-Z0-9_\-]+) version\s+([^.,;\n]+)/i,
  /database migrated to\s+([^.,;\n]+)/i,
];

const PROJECT_PATTERNS = [
  /project ([a-zA-Z0-9_\-]+) (?:is now|uses|stack is)\s+([^.,;\n]+)/i,
  /architecture for ([a-zA-Z0-9_\-]+) consists of\s+([^.,;\n]+)/i,
  /hackathon ([a-zA-Z0-9_\-]+) prize was\s+([^.,;\n]+)/i,
];

export function computeSalience(text: string): {
  salience: number;
  category: FactCategory;
  targetFile: "MEMORY.md" | "USER.md";
  section: string;
} {
  const lower = text.toLowerCase();

  // Check user preferences
  for (const pat of PREFERENCE_PATTERNS) {
    if (pat.test(lower)) {
      return {
        salience: 0.85,
        category: "user_preference",
        targetFile: "USER.md",
        section: "## User Preferences & Work Habits",
      };
    }
  }

  // Check system knowledge
  for (const pat of SYSTEM_PATTERNS) {
    if (pat.test(lower)) {
      return {
        salience: 0.8,
        category: "system_knowledge",
        targetFile: "MEMORY.md",
        section: "## System Knowledge & Configuration",
      };
    }
  }

  // Check project facts
  for (const pat of PROJECT_PATTERNS) {
    if (pat.test(lower)) {
      return {
        salience: 0.9,
        category: "project_fact",
        targetFile: "MEMORY.md",
        section: "## 2. Flagship Systems Portfolio & Architecture Knowledge Graph",
      };
    }
  }

  // General user profile cues
  if (
    lower.includes("my name is") ||
    lower.includes("i live in") ||
    lower.includes("i am studying at")
  ) {
    return {
      salience: 0.95,
      category: "user_profile",
      targetFile: "USER.md",
      section: "## User Identity & Biography",
    };
  }

  // Low-salience transient chat filter
  if (
    lower.startsWith("hi") ||
    lower.startsWith("hello") ||
    lower.startsWith("ok") ||
    lower.startsWith("yes") ||
    lower.startsWith("thanks") ||
    lower.includes("what time") ||
    lower.length < 15
  ) {
    return {
      salience: 0.1,
      category: "system_knowledge",
      targetFile: "MEMORY.md",
      section: "transient",
    };
  }

  return {
    salience: 0.3,
    category: "system_knowledge",
    targetFile: "MEMORY.md",
    section: "general",
  };
}

export async function parseSessionLogs(params: {
  sessionsDir: string;
  hoursWindow?: number;
  salienceThreshold?: number;
}): Promise<{ facts: ConsolidatedFact[]; discardedCount: number; processedCount: number }> {
  const threshold = params.salienceThreshold ?? 0.5;
  const cutoffTime = params.hoursWindow ? Date.now() - params.hoursWindow * 3600 * 1000 : 0;

  const facts: ConsolidatedFact[] = [];
  let discardedCount = 0;
  let processedCount = 0;

  let fileNames: string[] = [];
  try {
    const entries = await fs.readdir(params.sessionsDir, { withFileTypes: true });
    fileNames = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
  } catch {
    return { facts: [], discardedCount: 0, processedCount: 0 };
  }

  for (const fileName of fileNames) {
    const filePath = path.join(params.sessionsDir, fileName);
    try {
      const stat = await fs.stat(filePath);
      if (cutoffTime > 0 && stat.mtimeMs < cutoffTime) {
        continue;
      }
      processedCount++;

      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const role = item.role || item.message?.role;
          let text = "";

          if (typeof item.content === "string") {
            text = item.content;
          } else if (Array.isArray(item.content)) {
            text = item.content
              .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join(" ");
          } else if (typeof item.message?.content === "string") {
            text = item.message.content;
          }

          text = text.trim();
          if (!text) continue;

          // Sentences splitting
          const sentences = text.split(/(?<=[.?!])\s+/);
          for (const sentence of sentences) {
            const cleanSentence = sentence.trim();
            if (cleanSentence.length < 15) continue;

            const { salience, category, targetFile, section } = computeSalience(cleanSentence);

            if (salience >= threshold) {
              const hashId = crypto
                .createHash("sha256")
                .update(`${fileName}:${cleanSentence}`)
                .digest("hex")
                .slice(0, 12);
              facts.push({
                id: hashId,
                category,
                targetFile,
                section,
                content: cleanSentence,
                sourceSessionId: fileName.replace(/\.jsonl$/, ""),
                timestamp: stat.mtimeMs,
                salience,
              });
            } else {
              discardedCount++;
            }
          }
        } catch {
          // Ignore invalid JSON line
        }
      }
    } catch {
      // Ignore unreadable session file
    }
  }

  return { facts, discardedCount, processedCount };
}
