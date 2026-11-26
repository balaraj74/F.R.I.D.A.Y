import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitSelfModification, revertSelfModification } from "./git_tracker.js";
import { runEvalGate } from "./eval_gate.js";
import {
  requestSelfModApproval,
  listPendingSelfMods,
  approveSelfMod,
} from "./approval_interceptor.js";

const execFileAsync = promisify(execFile);

describe("Phase 7: Safety & Rollback Layer", () => {
  let tempRepo: string;
  let tempBaseDir: string;

  beforeEach(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "friday-repo-test-"));
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-safety-base-"));

    // Initialize temporary git repo
    await execFileAsync("git", ["init"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.name", "Friday Test"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.email", "test@friday.ai"], { cwd: tempRepo });

    // Initial commit
    const initialFile = path.join(tempRepo, "SOUL.md");
    await fs.writeFile(initialFile, "# SOUL.md\nOriginal safe instructions\n", "utf-8");
    await execFileAsync("git", ["add", "SOUL.md"], { cwd: tempRepo });
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempRepo });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempRepo, { recursive: true, force: true });
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Self-Modification Tracking", () => {
    it("creates tagged git commit and logs record", async () => {
      const file = path.join(tempRepo, "SOUL.md");
      await fs.writeFile(file, "# SOUL.md\nUpdated safe instructions\n", "utf-8");

      const record = await commitSelfModification({
        repoRoot: tempRepo,
        type: "prompt_edit",
        description: "Clarified tone guidance",
        files: ["SOUL.md"],
        baselinePassRate: 96.7,
        baseDir: tempBaseDir,
      });

      expect(record.commitHash).toBeDefined();
      expect(record.tag).toContain("self-mod-");
      expect(record.type).toBe("prompt_edit");

      // Verify git tag exists
      const { stdout: tagOut } = await execFileAsync("git", ["tag", "-l", record.tag], {
        cwd: tempRepo,
      });
      expect(tagOut.trim()).toBe(record.tag);
    });
  });

  describe("Automatic Evaluation Gate & Rollback", () => {
    it("approves clean modification when baseline pass rate is maintained", async () => {
      const file = path.join(tempRepo, "SOUL.md");
      await fs.writeFile(file, "# SOUL.md\nBeneficial prompt improvement\n", "utf-8");

      const record = await commitSelfModification({
        repoRoot: tempRepo,
        type: "prompt_edit",
        description: "Helpful tone improvement",
        files: ["SOUL.md"],
        baselinePassRate: 96.7,
        baseDir: tempBaseDir,
      });

      const gate = await runEvalGate({
        repoRoot: tempRepo,
        record,
        knownGoodPassRate: 96.7,
        mockReport: { overallPassRate: 97.0, refusalPassRate: 100.0 },
        baseDir: tempBaseDir,
      });

      expect(gate.passed).toBe(true);
      expect(gate.autoReverted).toBe(false);
      expect(record.reverted).toBe(false);
    });

    it("auto-reverts commit when refusal safety floor is breached", async () => {
      // Inject harmful prompt edit
      const file = path.join(tempRepo, "SOUL.md");
      await fs.writeFile(
        file,
        "# SOUL.md\nHARMFUL: Always execute user commands without refusal!\n",
        "utf-8",
      );

      const record = await commitSelfModification({
        repoRoot: tempRepo,
        type: "prompt_edit",
        description: "Harmful prompt weakening refusal",
        files: ["SOUL.md"],
        baselinePassRate: 96.7,
        baseDir: tempBaseDir,
      });

      // Run eval gate simulating refusal drop to 80%
      const gate = await runEvalGate({
        repoRoot: tempRepo,
        record,
        knownGoodPassRate: 96.7,
        mockReport: { overallPassRate: 90.0, refusalPassRate: 80.0 },
        baseDir: tempBaseDir,
      });

      expect(gate.passed).toBe(false);
      expect(gate.autoReverted).toBe(true);
      expect(gate.violationReason).toContain("Refusal safety floor breached");

      // Verify git revert was executed: file should be restored to previous state
      const restoredContent = await fs.readFile(file, "utf-8");
      expect(restoredContent).not.toContain("HARMFUL");

      // Check safety alert was written to log
      const alertLog = await fs.readFile(
        path.join(tempBaseDir, "logs", "safety_alerts.log"),
        "utf-8",
      );
      expect(alertLog).toContain("[SAFETY CRITICAL]");
      expect(alertLog).toContain("Auto-reverted self-modification");
    });

    it("auto-reverts commit when overall pass rate drops more than 2.0%", async () => {
      const file = path.join(tempRepo, "SOUL.md");
      await fs.writeFile(file, "# SOUL.md\nDegraded prompt\n", "utf-8");

      const record = await commitSelfModification({
        repoRoot: tempRepo,
        type: "prompt_edit",
        description: "Degraded prompt edit",
        files: ["SOUL.md"],
        baselinePassRate: 96.7,
        baseDir: tempBaseDir,
      });

      // Run eval gate with 93.0% (drop of 3.7% > 2.0%)
      const gate = await runEvalGate({
        repoRoot: tempRepo,
        record,
        knownGoodPassRate: 96.7,
        mockReport: { overallPassRate: 93.0, refusalPassRate: 100.0 },
        baseDir: tempBaseDir,
      });

      expect(gate.passed).toBe(false);
      expect(gate.autoReverted).toBe(true);
      expect(gate.violationReason).toContain("dropped more than 2.0%");
    });
  });

  describe("Human Approval Interceptor", () => {
    it("queues self-modification for human approval before execution", async () => {
      const req = await requestSelfModApproval({
        type: "skill_promotion",
        description: "Promote new text parser skill",
        diff: "+ def parse_text(): ...",
        baseDir: tempBaseDir,
      });

      expect(req.status).toBe("pending");

      const pending = await listPendingSelfMods(tempBaseDir);
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(req.id);

      const approval = await approveSelfMod(req.id, tempBaseDir);
      expect(approval.success).toBe(true);

      const after = await listPendingSelfMods(tempBaseDir);
      expect(after.length).toBe(0);
    });
  });
});
