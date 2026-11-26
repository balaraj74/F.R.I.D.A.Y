import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { critiqueAttempt } from "./reflector.js";
import { loadLessons, recordLesson } from "./self_model.js";
import { retrieveRelevantLessons } from "./retriever.js";

describe("Phase 6: Plan -> Act -> Reflect Subsystem", () => {
  let tempBaseDir: string;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-reflect-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Reflector Critique", () => {
    it("generates a concise 1-2 sentence lesson on timeout failure", () => {
      const lesson = critiqueAttempt({
        prompt: "Run full codebase scan",
        response: "",
        success: false,
        toolsUsed: ["exec"],
        error: "Execution timeout after 60s",
      });
      expect(typeof lesson).toBe("string");
      expect(lesson.length).toBeGreaterThan(15);
      expect(lesson.length).toBeLessThan(250);
      expect(lesson).toContain("smaller asynchronous steps");
    });

    it("generates a lesson advising targeted inspection on excessive tool usage", () => {
      const lesson = critiqueAttempt({
        prompt: "Find author of commit",
        response: "Author is Balaraj",
        success: true,
        toolsUsed: ["t1", "t2", "t3", "t4", "t5", "t6"],
      });
      expect(lesson).toContain("minimal tool budgets");
    });

    it("generates domain-specific lesson for git operations", () => {
      const lesson = critiqueAttempt({
        prompt: "Commit changes to git",
        response: "Committed",
        success: true,
        toolsUsed: ["exec"],
      });
      expect(lesson).toContain("inspect modified diffs");
    });
  });

  describe("Bounded Self-Model Storage", () => {
    it("records lessons and strictly bounds capacity via compaction", async () => {
      // Record 70 lessons into self-model with maxEntries 50 and compactionThreshold 60
      for (let i = 1; i <= 70; i++) {
        await recordLesson(
          {
            id: `lesson-${i}`,
            query: `Task number ${i}`,
            lesson: `Operational lesson number ${i} for simulated task.`,
            outcome: "success",
            timestamp: Date.now() + i,
          },
          tempBaseDir,
          { maxEntries: 50, compactionThreshold: 60 },
        );
      }

      const stored = await loadLessons(tempBaseDir);
      // Confirms bounded storage: entries must be <= 50!
      expect(stored.length).toBe(50);
      // Older items (1-20) were pruned
      expect(stored[0].id).toBe("lesson-21");
      expect(stored[49].id).toBe("lesson-70");
    });
  });

  describe("Retrieval & Prompt Injection", () => {
    it("retrieves the most relevant past lesson and formats prompt block", async () => {
      await recordLesson(
        {
          id: "docker-lesson",
          query: "Start docker container",
          lesson: "Verify port bindings and daemon connectivity before launching containers.",
          outcome: "success",
          timestamp: Date.now(),
        },
        tempBaseDir,
      );

      await recordLesson(
        {
          id: "git-lesson",
          query: "Git rebase origin main",
          lesson: "Stash uncommitted changes prior to rebasing branches.",
          outcome: "success",
          timestamp: Date.now(),
        },
        tempBaseDir,
      );

      const retrieval = await retrieveRelevantLessons({
        query: "How to deploy docker service",
        topK: 2,
        baseDir: tempBaseDir,
      });

      expect(retrieval.lessons.length).toBeGreaterThanOrEqual(1);
      expect(retrieval.lessons[0].id).toBe("docker-lesson");
      expect(retrieval.prompt).toContain("<reflective_lessons>");
      expect(retrieval.prompt).toContain("Verify port bindings");
    });

    it("handles cold start gracefully with empty prompt if no matching lessons", async () => {
      const retrieval = await retrieveRelevantLessons({
        query: "Unknown topic without lessons",
        baseDir: tempBaseDir,
      });
      expect(retrieval.lessons.length).toBe(0);
      expect(retrieval.prompt).toBe("");
    });
  });
});
