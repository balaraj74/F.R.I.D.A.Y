import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type {
  PromotionRequest,
  SandboxExecutionResult,
  SkillCandidate,
  SynthesisLog,
} from "./types.js";
import { runInSandbox } from "./sandbox.js";

export async function synthesizeSkill(
  candidate: SkillCandidate,
  options: { baseDir?: string } = {},
): Promise<{
  status: "staged" | "rejected";
  result: SandboxExecutionResult;
  candidate: SkillCandidate;
  promotionRequestId?: string;
}> {
  const baseDir = options.baseDir || path.join(os.homedir(), ".friday");
  const scratchDir = path.join(os.tmpdir(), `friday-synth-${Date.now()}-${candidate.name}`);
  const stagedDir = path.join(baseDir, "staged_skills", candidate.name);
  const logFile = path.join(baseDir, "logs", "skill_synthesis.jsonl");
  const pendingFile = path.join(baseDir, "pending_promotions.json");

  let executionResult: SandboxExecutionResult;
  try {
    executionResult = await runInSandbox({
      code: candidate.code,
      testCode: candidate.testCode,
      scratchDir,
      timeoutMs: 15000,
    });
  } finally {
    try {
      await fs.rm(scratchDir, { recursive: true, force: true });
    } catch {}
  }

  await fs.mkdir(path.dirname(logFile), { recursive: true });

  if (executionResult.passed) {
    // Stage skill for human promotion
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.writeFile(path.join(stagedDir, "solution.py"), candidate.code, "utf-8");
    await fs.writeFile(path.join(stagedDir, "test_solution.py"), candidate.testCode, "utf-8");

    const skillMd = `---
name: ${candidate.name}
description: ${candidate.description}
---

# ${candidate.name}

${candidate.description}

## Usage
Implemented in \`solution.py\`. Tested in isolated sandbox.
`;
    await fs.writeFile(path.join(stagedDir, "SKILL.md"), skillMd, "utf-8");

    const requestId = crypto.randomUUID();
    const promotionRequest: PromotionRequest = {
      id: requestId,
      skill: candidate,
      testResults: executionResult,
      status: "pending",
      requestedAt: Date.now(),
    };

    let existingRequests: PromotionRequest[] = [];
    try {
      const raw = await fs.readFile(pendingFile, "utf-8");
      existingRequests = JSON.parse(raw);
    } catch {
      existingRequests = [];
    }
    existingRequests.push(promotionRequest);
    await fs.writeFile(pendingFile, JSON.stringify(existingRequests, null, 2), "utf-8");

    const logEntry: SynthesisLog = {
      id: requestId,
      skillName: candidate.name,
      status: "staged",
      reason: "All sandbox unit tests passed. Staged for human approval.",
      timestamp: Date.now(),
    };
    await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n", "utf-8");

    return {
      status: "staged",
      result: executionResult,
      candidate,
      promotionRequestId: requestId,
    };
  } else {
    const logId = crypto.randomUUID();
    const logEntry: SynthesisLog = {
      id: logId,
      skillName: candidate.name,
      status: "rejected",
      reason: executionResult.errorReason || "Sandbox unit tests failed",
      timestamp: Date.now(),
    };
    await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n", "utf-8");

    return {
      status: "rejected",
      result: executionResult,
      candidate,
    };
  }
}
