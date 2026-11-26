export type FactCategory = "user_profile" | "user_preference" | "system_knowledge" | "project_fact";

export interface ConsolidatedFact {
  id: string;
  category: FactCategory;
  targetFile: "MEMORY.md" | "USER.md";
  section: string;
  content: string;
  sourceSessionId: string;
  timestamp: number;
  salience: number; // 0.0 to 1.0
}

export interface MemoryContradiction {
  id: string;
  existingFact: string;
  newFact: string;
  targetFile: "MEMORY.md" | "USER.md";
  section: string;
  conflictReason: string;
  flaggedAt: number;
  status: "pending" | "resolved" | "dismissed";
}

export interface ConsolidationOptions {
  workspaceDir?: string;
  sessionsDir?: string;
  hoursWindow?: number;
  salienceThreshold?: number;
  dryRun?: boolean;
  /**
   * Review mode: write the proposed MEMORY.md/USER.md plus a diff into
   * `<proposalsDir>/<YYYY-MM-DD>/` instead of editing the workspace. Apply with
   * `applyConsolidationProposal`. Ignored when `dryRun` is set.
   */
  proposalsDir?: string;
}

export interface ConsolidationRunResult {
  processedSessions: number;
  extractedFacts: number;
  discardedLowSalience: number;
  contradictionsFound: MemoryContradiction[];
  updatedFiles: string[];
  unifiedDiff: string;
  /** Set when a review proposal was written (proposalsDir mode). */
  proposalDir?: string;
}
