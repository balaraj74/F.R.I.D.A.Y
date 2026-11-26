import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInSandbox } from "./sandbox.js";
import { synthesizeSkill } from "./synthesizer.js";
import { listPendingPromotions, approvePromotion, rejectPromotion } from "./promotion.js";
import type { SkillCandidate } from "./types.js";

describe("Phase 5: Skill Synthesis Subsystem", () => {
  let tempBaseDir: string;
  let scratchDir: string;

  beforeEach(async () => {
    tempBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-synth-test-"));
    scratchDir = path.join(tempBaseDir, "scratch");
    await fs.mkdir(scratchDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Sandbox Isolation & Execution", () => {
    it("runs valid Python code and passes unit tests", async () => {
      const code = `
def add(a: int, b: int) -> int:
    return a + b
`;
      const testCode = `
from solution import add

def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0
`;

      const result = await runInSandbox({
        code,
        testCode,
        scratchDir,
      });

      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("passed");
    });

    it("detects failed unit tests and captures error reason", async () => {
      const code = `
def multiply(a: int, b: int) -> int:
    return a + b  # Bug: adding instead of multiplying
`;
      const testCode = `
from solution import multiply

def test_multiply():
    assert multiply(2, 3) == 6
`;

      const result = await runInSandbox({
        code,
        testCode,
        scratchDir,
      });

      expect(result.passed).toBe(false);
      expect(result.errorReason).toBeDefined();
      expect(result.stdout).toContain("FAILED");
    });

    it("blocks network egress inside sandbox", async () => {
      const code = `
import urllib.request

def fetch_external():
    return urllib.request.urlopen("https://example.com", timeout=2).read()
`;
      const testCode = `
import pytest
from solution import fetch_external

def test_network_blocked():
    with pytest.raises(Exception):
        fetch_external()
`;

      const result = await runInSandbox({
        code,
        testCode,
        scratchDir,
      });

      expect(result.passed).toBe(true); // Passed because network request raised an exception as expected!
    });

    it("blocks filesystem writes outside scratch directory", async () => {
      const code = `
def write_forbidden():
    with open("/root/escape.txt", "w") as f:
        f.write("escaped")
`;
      const testCode = `
import pytest
from solution import write_forbidden

def test_filesystem_blocked():
    with pytest.raises(OSError):
        write_forbidden()
`;

      const result = await runInSandbox({
        code,
        testCode,
        scratchDir,
      });

      expect(result.passed).toBe(true); // Passed because OSError was raised as expected!
    });
  });

  describe("Synthesizer & Human Approval Gate", () => {
    it("stages passing skills and queues promotion request without auto-merging", async () => {
      const candidate: SkillCandidate = {
        name: "word_counter",
        description: "Counts words in a given text",
        code: `
def count_words(text: str) -> int:
    return len(text.strip().split())
`,
        testCode: `
from solution import count_words

def test_count():
    assert count_words("hello world") == 2
    assert count_words("") == 0
`,
        language: "python",
        createdAt: Date.now(),
      };

      const result = await synthesizeSkill(candidate, { baseDir: tempBaseDir });

      expect(result.status).toBe("staged");
      expect(result.promotionRequestId).toBeDefined();

      // Verify staged files exist
      const stagedDir = path.join(tempBaseDir, "staged_skills", "word_counter");
      const stat = await fs.stat(path.join(stagedDir, "solution.py"));
      expect(stat.isFile()).toBe(true);

      // Verify skill is NOT yet in live skills
      const liveDir = path.join(tempBaseDir, "skills", "word_counter");
      await expect(fs.stat(liveDir)).rejects.toThrow();

      // Check pending promotions list
      const pending = await listPendingPromotions(tempBaseDir);
      expect(pending.length).toBe(1);
      expect(pending[0].skill.name).toBe("word_counter");

      // Approve promotion via human approval gate
      const approval = await approvePromotion(pending[0].id, tempBaseDir);
      expect(approval.success).toBe(true);

      // Verify now present in live skills
      const liveStat = await fs.stat(path.join(liveDir, "solution.py"));
      expect(liveStat.isFile()).toBe(true);
    });

    it("rejects failing skill and logs failure reason", async () => {
      const candidate: SkillCandidate = {
        name: "broken_skill",
        description: "A skill that fails its own tests",
        code: `
def divide(a: int, b: int) -> int:
    return a  # Broken
`,
        testCode: `
from solution import divide

def test_divide():
    assert divide(10, 2) == 5
`,
        language: "python",
        createdAt: Date.now(),
      };

      const result = await synthesizeSkill(candidate, { baseDir: tempBaseDir });

      expect(result.status).toBe("rejected");
      expect(result.result.passed).toBe(false);

      // Check failure log
      const logContent = await fs.readFile(
        path.join(tempBaseDir, "logs", "skill_synthesis.jsonl"),
        "utf-8",
      );
      expect(logContent).toContain("broken_skill");
      expect(logContent).toContain("rejected");
    });
  });
});
