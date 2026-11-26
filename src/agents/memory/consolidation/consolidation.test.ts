import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { computeSalience, parseSessionLogs } from "./parser.js";
import { detectContradiction } from "./contradiction.js";
import { consolidateMemories, insertFactIntoMarkdown } from "./consolidator.js";
import type { ConsolidatedFact } from "./types.js";

describe("Phase 4: Memory Consolidation Subsystem", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-mem-test-"));
    sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Salience & Parser", () => {
    it("assigns high salience to user preferences", () => {
      const res = computeSalience("I prefer dark theme for all code editors");
      expect(res.salience).toBeGreaterThanOrEqual(0.8);
      expect(res.category).toBe("user_preference");
      expect(res.targetFile).toBe("USER.md");
    });

    it("assigns high salience to project facts", () => {
      const res = computeSalience("Project Cinetra stack is Python FastAPI and React");
      expect(res.salience).toBeGreaterThanOrEqual(0.85);
      expect(res.category).toBe("project_fact");
      expect(res.targetFile).toBe("MEMORY.md");
    });

    it("discards low-salience transient chatter", () => {
      const res = computeSalience("hello what time is it?");
      expect(res.salience).toBeLessThan(0.5);
    });

    it("parses synthetic session logs and extracts durable facts", async () => {
      const sessionPath = path.join(sessionsDir, "test-session.jsonl");
      const lines = [
        JSON.stringify({ role: "user", content: "Hi FRIDAY" }),
        JSON.stringify({ role: "assistant", content: "Hello Sir! How may I assist you?" }),
        JSON.stringify({
          role: "user",
          content: "Please remember that I prefer TypeScript for all new backend services.",
        }),
        JSON.stringify({
          role: "assistant",
          content:
            "Understood, Sir. I will remember that you prefer TypeScript for backend services.",
        }),
      ];
      await fs.writeFile(sessionPath, lines.join("\n"), "utf-8");

      const parsed = await parseSessionLogs({
        sessionsDir,
        salienceThreshold: 0.5,
      });

      expect(parsed.facts.length).toBeGreaterThan(0);
      expect(parsed.discardedCount).toBeGreaterThan(0);
      expect(parsed.facts.some((f) => f.content.includes("prefer TypeScript"))).toBe(true);
    });
  });

  describe("Contradiction Detection", () => {
    it("flags direct contradiction between light theme and dark theme preference", () => {
      const existingDoc = "# USER.md\n- prefers dark theme for IDEs";
      const newFact: ConsolidatedFact = {
        id: "fact-1",
        category: "user_preference",
        targetFile: "USER.md",
        section: "## User Preferences",
        content: "I switched to light theme permanently",
        sourceSessionId: "session-1",
        timestamp: Date.now(),
        salience: 0.9,
      };

      const conflict = detectContradiction(newFact, existingDoc);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflictReason).toContain("contradiction on UI theme preference");
      expect(conflict?.status).toBe("pending");
    });

    it("flags direct contradiction on user location", () => {
      const existingDoc = "Location: Bengaluru, Karnataka, India";
      const newFact: ConsolidatedFact = {
        id: "fact-2",
        category: "user_profile",
        targetFile: "USER.md",
        section: "## User Profile",
        content: "I moved to San Francisco yesterday",
        sourceSessionId: "session-2",
        timestamp: Date.now(),
        salience: 0.95,
      };

      const conflict = detectContradiction(newFact, existingDoc);
      expect(conflict).not.toBeNull();
      expect(conflict?.conflictReason).toContain("Contradiction on primary user location");
    });

    it("returns null when no contradiction exists", () => {
      const existingDoc = "Location: Bengaluru, Karnataka, India\n- prefers dark theme";
      const newFact: ConsolidatedFact = {
        id: "fact-3",
        category: "user_preference",
        targetFile: "USER.md",
        section: "## User Preferences",
        content: "I prefer using Vitest over Jest",
        sourceSessionId: "session-3",
        timestamp: Date.now(),
        salience: 0.85,
      };

      const conflict = detectContradiction(newFact, existingDoc);
      expect(conflict).toBeNull();
    });
  });

  describe("Consolidation & Git Diff", () => {
    it("inserts new facts under the matching section header", () => {
      const original = "# USER.md\n\n## User Preferences & Work Habits\n- Existing preference";
      const newFact: ConsolidatedFact = {
        id: "fact-4",
        category: "user_preference",
        targetFile: "USER.md",
        section: "## User Preferences & Work Habits",
        content: "Always use strict TypeScript mode",
        sourceSessionId: "session-4",
        timestamp: Date.now(),
        salience: 0.85,
      };

      const updated = insertFactIntoMarkdown(original, newFact);
      expect(updated).toContain("- Always use strict TypeScript mode");
      expect(updated).toContain("- Existing preference");
    });

    it("runs end-to-end consolidation, produces unified diff, and flags inserted contradiction", async () => {
      const memPath = path.join(tempDir, "MEMORY.md");
      const userPath = path.join(tempDir, "USER.md");

      await fs.writeFile(
        memPath,
        "# MEMORY.md\n\n## System Knowledge & Configuration\n- Docker configured\n",
        "utf-8",
      );
      await fs.writeFile(
        userPath,
        "# USER.md\n\n## User Preferences & Work Habits\n- prefers dark theme\nLocation: Bengaluru\n",
        "utf-8",
      );

      // Insert 2 sessions: 1 valid fact, 1 deliberate contradiction
      const s1 = path.join(sessionsDir, "valid-pref.jsonl");
      await fs.writeFile(
        s1,
        JSON.stringify({
          role: "user",
          content: "Please remember that I prefer pnpm over npm.",
        }) + "\n",
      );

      const s2 = path.join(sessionsDir, "contradiction.jsonl");
      await fs.writeFile(
        s2,
        JSON.stringify({
          role: "user",
          content: "I switched to light theme permanently.",
        }) + "\n",
      );

      const result = await consolidateMemories({
        workspaceDir: tempDir,
        sessionsDir,
        dryRun: false,
      });

      expect(result.extractedFacts).toBe(1); // Only the valid non-contradicted fact accepted
      expect(result.contradictionsFound.length).toBe(1); // Deliberate contradiction flagged
      expect(result.contradictionsFound[0].conflictReason).toContain(
        "contradiction on UI theme preference",
      );
      expect(result.unifiedDiff).toContain("--- a/USER.md");
      expect(result.unifiedDiff).toContain("+ - Please remember that I prefer pnpm over npm.");

      // Check USER.md content: valid fact was added, contradicted fact was NOT added
      const finalUser = await fs.readFile(userPath, "utf-8");
      expect(finalUser).toContain("pnpm over npm");
      expect(finalUser).not.toContain("light theme");
    });
  });
});
