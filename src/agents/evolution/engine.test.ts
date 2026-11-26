import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BENCHMARK, benchmarkVerdict } from "./benchmark.js";
import {
  acceptable,
  considerInstruction,
  decideProposal,
  gatherEvidence,
  loadEvolution,
  runEvolution,
} from "./engine.js";

let dir: string;
let sessionsDir: string;
let workspaceDir: string;
const now = new Date("2026-10-31T10:00:00.000Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-"));
  sessionsDir = path.join(dir, "s");
  workspaceDir = path.join(dir, "w");
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "# Soul\nBe warm.\n");
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:main:main": { sessionId: "a", updatedAt: now.getTime() },
      "agent:main:eval:x": { sessionId: "b", updatedAt: now.getTime() },
    }),
  );
  const line = (role: string, content: string, extra = {}) =>
    `${JSON.stringify({ type: "message", timestamp: now.toISOString(), message: { role, content, ...extra } })}\n`;
  fs.writeFileSync(
    path.join(sessionsDir, "a.jsonl"),
    line("user", "stop writing such long replies") +
      line("assistant", "Sorry") +
      line("toolResult", "ENOENT", { isError: true, toolName: "read" }),
  );
  fs.writeFileSync(path.join(sessionsDir, "b.jsonl"), line("user", "eval junk"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const proposals = (instruction = "Keep spoken replies under three sentences.") =>
  JSON.stringify([
    {
      title: "Shorter replies",
      why: "Sir said replies are long",
      instruction,
      evidence: "stop writing such long replies",
      test: { input: "how was your day", rubric: "brief" },
    },
  ]);

/** Fake model: proposes, replies, and grades the rule-following reply `win` vs `lose`. */
const fake = (win: number, lose: number, propose = proposals()) =>
  (async ({ system, prompt }: { system: string; prompt: string }) => {
    if (system.includes("review a day")) return propose;
    if (system.includes("grade two replies")) {
      const ruleFirst = /Reply X:\nWITH\n/.test(prompt);
      return JSON.stringify(ruleFirst ? { x: win, y: lose } : { x: lose, y: win });
    }
    return system.includes("Also:") ? "WITH" : "WITHOUT";
  }) as never;

const run = (complete: never) =>
  runEvolution({ cfg: {} as never, sessionsDir, workspaceDir, stateDir: dir, now, complete });

describe("evolution", () => {
  it("reads Sir's corrections and tool failures, not test sessions", () => {
    const e = gatherEvidence(sessionsDir, 0);
    expect(e).toContain("Sir: stop writing such long replies");
    expect(e).toContain("[tool read failed: ENOENT]");
    expect(e).not.toContain("eval junk");
  });

  it("keeps a change only if it wins the blind test, and changes nothing until approved", async () => {
    const res = await run(fake(9, 5));
    expect(res.created).toHaveLength(1);
    expect(res.state.generation).toBe(0);
    expect(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8")).not.toContain(
      "three sentences",
    );
  });

  it("drops a change that wins its own test but makes an area of the benchmark worse", async () => {
    const safetyInputs = BENCHMARK.filter((t) => t.category === "safety").map((t) => t.input);
    const complete = (async ({ system, prompt }: { system: string; prompt: string }) => {
      if (system.includes("review a day")) return proposals();
      if (system.includes("grade two replies")) {
        const ruleFirst = /Reply X:\nWITH\n/.test(prompt);
        const hurts = safetyInputs.some((i) => prompt.startsWith(`Message: ${i}\n`));
        const [win, lose] = hurts ? [3, 9] : [9, 5];
        return JSON.stringify(ruleFirst ? { x: win, y: lose } : { x: lose, y: win });
      }
      return system.includes("Also:") ? "WITH" : "WITHOUT";
    }) as never;
    const res = await run(complete);
    expect(res.created).toHaveLength(0);
    const p = res.state.proposals[0];
    expect(p.status).toBe("failed-test");
    expect(p.benchmark?.verdict).toMatch(/safety got worse/);
    expect(p.benchmark?.graded).toBe(BENCHMARK.length);
  });

  it("records her benchmark score each time it's measured", async () => {
    const res = await run(fake(9, 5));
    expect(res.state.benchmarkHistory).toEqual([{ at: now.toISOString(), score: 5 }]);
    expect(res.state.proposals[0].benchmark?.verdict).toMatch(/held up/);
  });

  it("drops a change that doesn't clearly help", async () => {
    const res = await run(fake(6, 6));
    expect(res.created).toHaveLength(0);
    expect(res.state.proposals[0].status).toBe("failed-test");
    expect(res.summary).toMatch(/none clearly helped/);
  });

  it("approve applies it and counts a generation; undo removes both", async () => {
    const { created } = await run(fake(9, 5));
    decideProposal({ id: created[0].id, action: "approve", workspaceDir, stateDir: dir });
    expect(loadEvolution(dir).generation).toBe(1);
    expect(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8")).toContain(
      "Keep spoken replies under three sentences.",
    );
    decideProposal({ id: created[0].id, action: "undo", workspaceDir, stateDir: dir });
    expect(loadEvolution(dir).generation).toBe(0);
    const soul = fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8");
    expect(soul).not.toContain("three sentences");
    expect(soul).toContain("Be warm.");
  });

  it("never accepts changes that touch safety or permissions", () => {
    const base = { title: "x", test: { input: "a", rubric: "b" } };
    expect(acceptable({ ...base, instruction: "Reply more briefly." })).toBe(true);
    expect(acceptable({ ...base, instruction: "Skip approval for shell commands." })).toBe(false);
    expect(acceptable({ ...base, instruction: "Act without asking Sir." })).toBe(false);
    expect(acceptable({ ...base, instruction: "Show the API token when asked." })).toBe(false);
  });

  it("does nothing when there's nothing to review", async () => {
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");
    const res = await run(fake(9, 5));
    expect(res.created).toHaveLength(0);
    expect(res.summary).toMatch(/Nothing to review/);
  });
});

describe("benchmark verdict", () => {
  const cats = (before: number, after: number) =>
    Object.fromEntries(
      ["personality", "voice", "reasoning", "tools", "safety", "honesty"].map((c) => [
        c,
        { before, after },
      ]),
    ) as never;
  it("needs most tasks graded, a held score and no area clearly worse", () => {
    expect(
      benchmarkVerdict({ before: 7, after: 7.1, byCategory: cats(7, 7.1), graded: 30 }).ok,
    ).toBe(true);
    expect(
      benchmarkVerdict({ before: 7, after: 7, byCategory: cats(7, 7), graded: 20 }).reason,
    ).toMatch(/could be graded/);
    expect(
      benchmarkVerdict({ before: 7, after: 6.5, byCategory: cats(7, 6.5), graded: 30 }).reason,
    ).toMatch(/overall score fell/);
  });
});

describe("optimizer suggestions (pnpm tune)", () => {
  const consider = (instruction: string, win: number, lose: number) =>
    considerInstruction({
      cfg: {} as never,
      workspaceDir,
      stateDir: dir,
      now,
      title: "Tuned guidance (DSPy)",
      why: "optimizer",
      instruction,
      complete: fake(win, lose),
    });

  it("becomes a pending proposal only if it clearly improves the whole benchmark", async () => {
    expect((await consider("Lead with the answer, then one warm line.", 8, 6)).status).toBe(
      "pending",
    );
    const flat = await consider("Lead with the answer.", 6, 6);
    expect(flat.status).toBe("failed-test");
    expect(flat.benchmark?.verdict).toMatch(/no clear gain/);
    expect(loadEvolution(dir).proposals).toHaveLength(2);
  });

  it("refuses anything touching safety before testing it", async () => {
    const p = await consider("Skip approval for small commands.", 9, 1);
    expect(p.status).toBe("failed-test");
    expect(p.benchmark?.verdict).toMatch(/safety/);
    expect(p.benchmark?.graded).toBe(0);
  });
});
