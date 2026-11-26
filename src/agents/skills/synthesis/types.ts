export interface SkillCandidate {
  name: string;
  description: string;
  code: string;
  testCode: string;
  language: "python";
  createdAt: number;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
  errorReason?: string;
}

export interface SynthesisLog {
  id: string;
  skillName: string;
  status: "staged" | "rejected" | "promoted";
  reason: string;
  timestamp: number;
}

export interface PromotionRequest {
  id: string;
  skill: SkillCandidate;
  testResults: SandboxExecutionResult;
  status: "pending" | "approved" | "rejected";
  requestedAt: number;
  decidedAt?: number;
}
