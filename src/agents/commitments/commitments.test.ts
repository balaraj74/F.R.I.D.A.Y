import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationLines, parseExtraction, scanForCommitments } from "./extract.js";
import {
  attentionCommitments,
  dueBucket,
  loadCommitments,
  updateCommitment,
  upsertCommitment,
} from "./store.js";

let stateDir: string;
const now = new Date("2026-10-22T10:00:00.000Z");
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "commitments-"));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const add = (text: string, extra: Record<string, unknown> = {}) =>
  upsertCommitment(
    { text, owner: "sir", source: { kind: "manual", at: now.toISOString() }, ...extra },
    { stateDir, now },
  );

describe("commitment store", () => {
  it("dedupes the same promise and fills in a missing deadline", () => {
    const a = add("Send the deck to Ravi", { who: "Ravi" });
    const b = add("send Ravi the deck", { who: "Ravi", due: "2026-10-23T12:30:00.000Z" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const list = loadCommitments(stateDir);
    expect(list).toHaveLength(1);
    expect(list[0].due).toBe("2026-10-23T12:30:00.000Z");
  });

  it("buckets by deadline and surfaces only what needs attention", () => {
    add("Pay rent", { due: "2026-10-22T09:00:00.000Z" }); // overdue
    add("Call the bank", { due: "2026-10-22T11:30:00.000Z" }); // within 3h
    add("Book flights", { due: "2026-10-27T10:00:00.000Z" }); // later this week
    add("Learn Rust"); // undated
    const items = attentionCommitments(loadCommitments(stateDir), now);
    expect(items.map((c) => [c.text, c.bucket])).toEqual([
      ["Pay rent", "overdue"],
      ["Call the bank", "soon"],
    ]);
    const all = loadCommitments(stateDir);
    expect(dueBucket(all[2], now)).toBe("week");
    expect(dueBucket(all[3], now)).toBe("undated");
  });

  it("hides snoozed and closed items", () => {
    const { commitment } = add("Pay rent", { due: "2026-10-22T09:00:00.000Z" });
    updateCommitment(commitment.id, { snoozedUntil: "2026-10-22T12:00:00.000Z" }, { stateDir });
    expect(attentionCommitments(loadCommitments(stateDir), now)).toHaveLength(0);
    updateCommitment(commitment.id, { snoozedUntil: undefined, status: "done" }, { stateDir });
    expect(attentionCommitments(loadCommitments(stateDir), now)).toHaveLength(0);
  });
});

describe("extraction", () => {
  it("reads only Sir/FRIDAY text, dropping heartbeat noise and message ids", () => {
    const jsonl = [
      {
        type: "message",
        timestamp: now.toISOString(),
        message: { role: "user", content: "I'll send Ravi the deck Friday [message_id: run_1]" },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: { role: "user", content: "Read HEARTBEAT.md and act" },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
      },
      {
        type: "message",
        timestamp: now.toISOString(),
        message: { role: "toolResult", content: "x" },
      },
      { type: "custom", data: {} },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(conversationLines(jsonl, "agent:main:main")).toEqual([
      {
        role: "user",
        text: "I'll send Ravi the deck Friday",
        at: now.toISOString(),
        sessionKey: "agent:main:main",
      },
    ]);
  });

  it("parses a JSON array out of model chatter", () => {
    expect(parseExtraction('Sure:\n```json\n[{"text":"x"}]\n```')).toEqual([{ text: "x" }]);
    expect(parseExtraction("nothing here")).toEqual([]);
    // Cut off by the token limit: keep the complete items.
    expect(parseExtraction('[{"text":"a","who":null},{"text":"b"},{"text":"c","du')).toEqual([
      { text: "a", who: null },
      { text: "b" },
    ]);
  });

  it("scans new transcript lines once, skips test sessions, and stores confident items", async () => {
    const sessionsDir = path.join(stateDir, "sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionId: "s1" },
        "agent:main:eval:x": { sessionId: "s2" },
      }),
    );
    const line = (role: string, text: string) =>
      `${JSON.stringify({ type: "message", timestamp: now.toISOString(), message: { role, content: text } })}\n`;
    fs.writeFileSync(
      path.join(sessionsDir, "s1.jsonl"),
      line("user", "Remind me: I promised Ravi the deck by Friday"),
    );
    fs.writeFileSync(path.join(sessionsDir, "s2.jsonl"), line("user", "eval: promise to pay Bob"));
    const prompts: string[] = [];
    const complete = async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return JSON.stringify([
        {
          text: "Send the deck to Ravi",
          who: "Ravi",
          owner: "sir",
          due: "2026-10-23T18:00:00+05:30",
          dueText: "by Friday",
          quote: "deck by Friday",
          confidence: 0.9,
        },
        { text: "Something vague", owner: "sir", confidence: 0.3 },
      ]);
    };
    const cfg = {};
    const first = await scanForCommitments({
      cfg,
      sessionsDir,
      stateDir,
      now,
      complete: complete as never,
    });
    expect(first).toMatchObject({ added: 1, lines: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("Bob");
    const [c] = loadCommitments(stateDir);
    expect(c).toMatchObject({
      text: "Send the deck to Ravi",
      who: "Ravi",
      due: "2026-10-23T12:30:00.000Z",
    });

    // Nothing new → no model call.
    const second = await scanForCommitments({
      cfg,
      sessionsDir,
      stateDir,
      now,
      complete: complete as never,
    });
    expect(second.lines).toBe(0);
    expect(prompts).toHaveLength(1);
  });
});
