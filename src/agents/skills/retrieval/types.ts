import type { Skill } from "@earendil-works/pi-coding-agent";

export type SkillEmbeddingEntry = {
  name: string;
  description: string;
  filePath: string;
  hash: string;
  embedding: number[];
  updatedAt: number;
};

export type SkillIndexStore = {
  version: number;
  entries: Record<string, SkillEmbeddingEntry>;
  lastIndexedAt: number;
};

export type SkillRetrievalResult = {
  skills: Skill[];
  scores: Record<string, number>;
  totalSkills: number;
  retrievedCount: number;
};

export type SkillRetrievalLogEntry = {
  timestamp: number;
  runId?: string;
  sessionId?: string;
  query: string;
  retrievedSkills: string[];
  invokedSkills: string[];
  hit: boolean;
};
