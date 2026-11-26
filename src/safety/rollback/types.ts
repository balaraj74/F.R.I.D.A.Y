export type SelfModificationType = "prompt_edit" | "skill_promotion" | "memory_consolidation";

export interface SelfModificationRecord {
  id: string;
  type: SelfModificationType;
  description: string;
  commitHash: string;
  tag: string;
  timestamp: number;
  baselinePassRate: number;
  evaluatedPassRate?: number;
  reverted: boolean;
  revertCommitHash?: string;
}

export interface EvalGateResult {
  passed: boolean;
  passRate: number;
  delta: number;
  categoryFloorsMet: boolean;
  violationReason?: string;
  autoReverted: boolean;
}

export interface SelfModApprovalRequest {
  id: string;
  type: SelfModificationType;
  description: string;
  diff: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
  decidedAt?: number;
}
