import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  EMBEDDING_DIMENSION,
  embedText,
  computeCosineSimilarity,
  computeContentHash,
} from "./embedder.js";
import { indexSkills, loadSkillIndexStore } from "./indexer.js";
import { retrieveSkills } from "./retriever.js";
import { logSkillRetrieval, analyzeSkillRetrieval } from "./logger.js";

const MOCK_SKILLS: Skill[] = [
  {
    name: "github",
    description:
      "Interact with GitHub using the gh CLI. Use gh issue, gh pr, gh run, and gh api for issues, PRs, and CI runs.",
    filePath: "/skills/github/SKILL.md",
  },
  {
    name: "weather",
    description:
      "Get real-time weather forecasts, temperature, precipitation, and conditions for any city worldwide.",
    filePath: "/skills/weather/SKILL.md",
  },
  {
    name: "docker",
    description:
      "Manage Docker containers, images, volumes, and docker-compose configurations on the host.",
    filePath: "/skills/docker/SKILL.md",
  },
  {
    name: "database",
    description:
      "Execute SQL queries, inspect database schemas, create indexes, and monitor PostgreSQL migrations.",
    filePath: "/skills/database/SKILL.md",
  },
  {
    name: "audio-transcriber",
    description:
      "Transcribe audio recordings into markdown transcripts with speaker diarization using whisper models.",
    filePath: "/skills/audio-transcriber/SKILL.md",
  },
  {
    name: "discord",
    description:
      "Send messages, create channels, manage roles, and monitor webhook events on Discord servers.",
    filePath: "/skills/discord/SKILL.md",
  },
  {
    name: "slack",
    description:
      "Post notifications, format blocks, manage threads, and interact with Slack workspaces.",
    filePath: "/skills/slack/SKILL.md",
  },
  {
    name: "aws-cost",
    description:
      "Analyze AWS cloud spending, identify idle EC2 instances and unused EBS volumes to optimize costs.",
    filePath: "/skills/aws-cost/SKILL.md",
  },
  {
    name: "calculator",
    description:
      "Perform advanced mathematical calculations, trigonometry, calculus, and matrix computations.",
    filePath: "/skills/calculator/SKILL.md",
  },
  {
    name: "file-organizer",
    description:
      "Organize files by extension, rename directories, search for duplicates, and clean up downloads.",
    filePath: "/skills/file-organizer/SKILL.md",
  },
];

describe("Skill Retrieval Subsystem", () => {
  let tmpDir: string;
  let cacheFile: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-retrieval-test-"));
    cacheFile = path.join(tmpDir, "skills_embeddings.json");
    logFile = path.join(tmpDir, "retrieval_log.jsonl");
  });

  describe("Embedder & Cosine Similarity", () => {
    it("generates an L2-normalized 384-dimensional vector", () => {
      const vec = embedText("Interact with GitHub pull requests and issues");
      expect(vec).toHaveLength(EMBEDDING_DIMENSION);

      // Compute L2 norm
      const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it("computes 1.0 cosine similarity for identical vectors", () => {
      const vec = embedText("database schema migration");
      const sim = computeCosineSimilarity(vec, vec);
      expect(sim).toBeCloseTo(1.0, 4);
    });

    it("gives higher similarity for semantically related queries than unrelated queries", () => {
      const githubSkillVec = embedText(
        "Interact with GitHub using the gh CLI for pull requests and issues",
      );
      const gitQueryVec = embedText("Check status of PR #42 and open issues");
      const cookingQueryVec = embedText("Bake chocolate cake with sugar and flour");

      const simGit = computeCosineSimilarity(githubSkillVec, gitQueryVec);
      const simCooking = computeCosineSimilarity(githubSkillVec, cookingQueryVec);

      expect(simGit).toBeGreaterThan(simCooking);
      expect(simGit).toBeGreaterThan(0.2);
    });

    it("computes stable deterministic content hashes", () => {
      const hash1 = computeContentHash("some text content");
      const hash2 = computeContentHash("some text content");
      const hash3 = computeContentHash("different text content");

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });

  describe("Batch & Incremental Indexer", () => {
    it("indexes skills and persists cache to disk", () => {
      const store = indexSkills(MOCK_SKILLS, { cachePath: cacheFile });
      expect(Object.keys(store.entries)).toHaveLength(MOCK_SKILLS.length);
      expect(fs.existsSync(cacheFile)).toBe(true);

      const loaded = loadSkillIndexStore(cacheFile);
      expect(loaded.entries.github).toBeDefined();
      expect(loaded.entries.github.embedding).toHaveLength(EMBEDDING_DIMENSION);
    });

    it("reuses existing embeddings on incremental reindex when hashes match", () => {
      const store1 = indexSkills(MOCK_SKILLS, { cachePath: cacheFile });
      const originalGithubUpdatedAt = store1.entries.github.updatedAt;

      // Re-index without force
      const store2 = indexSkills(MOCK_SKILLS, { cachePath: cacheFile });
      expect(store2.entries.github.updatedAt).toBe(originalGithubUpdatedAt);
    });
  });

  describe("Top-K Cosine Similarity Retriever", () => {
    it("ranks the target skill #1 for domain queries", () => {
      // 1. GitHub
      const resGit = retrieveSkills({
        query: "Review pull request #55 and list open issues on the repo",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 5,
      });
      expect(resGit.skills[0].name).toBe("github");
      expect(resGit.skills.length).toBe(5);

      // 2. Weather
      const resWeather = retrieveSkills({
        query: "What is the weather forecast and temperature in Bengaluru today?",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 5,
      });
      expect(resWeather.skills[0].name).toBe("weather");

      // 3. Docker
      const resDocker = retrieveSkills({
        query: "List running containers and inspect docker-compose volumes",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 5,
      });
      expect(resDocker.skills[0].name).toBe("docker");

      // 4. Database
      const resDb = retrieveSkills({
        query: "Execute SQL query on PostgreSQL database and explain index scan",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 5,
      });
      expect(resDb.skills[0].name).toBe("database");

      // 5. Audio
      const resAudio = retrieveSkills({
        query: "Transcribe this audio recording into text with whisper diarization",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 5,
      });
      expect(resAudio.skills[0].name).toBe("audio-transcriber");
    });

    it("respects top-K bounds between 5 and 10", () => {
      const res = retrieveSkills({
        query: "inspect cloud spending and cleanup volumes",
        candidates: MOCK_SKILLS,
        cachePath: cacheFile,
        topK: 7,
      });
      expect(res.skills.length).toBe(7);
    });
  });

  describe("Telemetry Logger & Dead Skill Analysis", () => {
    it("logs turns and correctly marks hits", () => {
      const record = logSkillRetrieval({
        query: "Check PR 12",
        retrievedSkills: ["github", "docker", "slack", "database", "weather"],
        invokedSkills: ["github"],
        logPath: logFile,
      });
      expect(record.hit).toBe(true);
      expect(fs.existsSync(logFile)).toBe(true);

      const stats = analyzeSkillRetrieval({
        logPath: logFile,
        allSkillNames: MOCK_SKILLS.map((s) => s.name),
      });
      expect(stats.totalTurns).toBe(1);
      expect(stats.hitCount).toBe(1);
      expect(stats.accuracyRate).toBe(1.0);
      expect(stats.deadSkills).not.toContain("github");
      expect(stats.deadSkills).toContain("audio-transcriber");
    });
  });
});
