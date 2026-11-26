import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyConsolidationProposal, consolidateMemories } from "./consolidator.js";
import { msUntilNextLocalTime } from "./scheduler.js";

describe("memory consolidation review proposals", () => {
  let tempDir: string;
  let sessionsDir: string;
  let proposalsDir: string;
  let userPath: string;
  const originalUser = "# USER.md\n\n## User Preferences & Work Habits\n- prefers dark theme\n";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-consolidation-proposal-"));
    sessionsDir = path.join(tempDir, "sessions");
    proposalsDir = path.join(tempDir, "proposals");
    await fs.mkdir(sessionsDir, { recursive: true });
    userPath = path.join(tempDir, "USER.md");
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# MEMORY.md\n", "utf-8");
    await fs.writeFile(userPath, originalUser, "utf-8");
    await fs.writeFile(
      path.join(sessionsDir, "pref.jsonl"),
      JSON.stringify({ role: "user", content: "Please remember that I prefer pnpm over npm." }) +
        "\n",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes a proposal instead of editing USER.md", async () => {
    const result = await consolidateMemories({ workspaceDir: tempDir, sessionsDir, proposalsDir });
    expect(result.proposalDir).toBeTruthy();
    expect(await fs.readFile(userPath, "utf-8")).toBe(originalUser);
    const review = await fs.readFile(path.join(result.proposalDir!, "REVIEW.md"), "utf-8");
    expect(review).toContain("pnpm over npm");
    expect(review).toContain("friday memory consolidate --apply");
  });

  it("applies a reviewed proposal", async () => {
    const result = await consolidateMemories({ workspaceDir: tempDir, sessionsDir, proposalsDir });
    const { applied } = await applyConsolidationProposal(result.proposalDir!);
    expect(applied).toEqual(["USER.md"]);
    expect(await fs.readFile(userPath, "utf-8")).toContain("pnpm over npm");
  });

  it("refuses to apply a proposal when the file changed since", async () => {
    const result = await consolidateMemories({ workspaceDir: tempDir, sessionsDir, proposalsDir });
    await fs.appendFile(userPath, "- edited by hand after the proposal\n", "utf-8");
    await expect(applyConsolidationProposal(result.proposalDir!)).rejects.toThrow(/changed since/);
    expect(await fs.readFile(userPath, "utf-8")).toContain("edited by hand");
  });

  it("dry run writes neither files nor proposals", async () => {
    const result = await consolidateMemories({
      workspaceDir: tempDir,
      sessionsDir,
      proposalsDir,
      dryRun: true,
    });
    expect(result.proposalDir).toBeUndefined();
    await expect(fs.stat(proposalsDir)).rejects.toThrow();
  });
});

describe("msUntilNextLocalTime", () => {
  it("targets later today, or tomorrow once the time has passed", () => {
    const at = (h: number, m: number) => {
      const d = new Date(2026, 9, 22, h, m, 0, 0);
      return d;
    };
    expect(msUntilNextLocalTime(3, 30, at(1, 0))).toBe(150 * 60_000);
    expect(msUntilNextLocalTime(3, 30, at(4, 0))).toBe((23 * 60 + 30) * 60_000);
  });
});
