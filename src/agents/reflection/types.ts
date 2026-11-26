export interface OperationalLesson {
  id: string;
  query: string;
  lesson: string;
  outcome: "success" | "failure" | "partial";
  timestamp: number;
  embedding?: number[];
}

export interface SelfModelConfig {
  maxEntries: number; // default: 50
  compactionThreshold: number; // default: 60
}

export interface CritiqueParams {
  prompt: string;
  response: string;
  success: boolean;
  toolsUsed: string[];
  error?: string;
}
