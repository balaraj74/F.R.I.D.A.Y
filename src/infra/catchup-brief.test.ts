import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { upsertCommitment } from "../agents/commitments/store.js";
import {
  buildCatchupBrief,
  calendarItems,
  markSessionStart,
  markSessionStop,
  plainSpoken,
} from "./catchup-brief.js";

let stateDir: string;
let workspaceDir: string;
const now = new Date("2026-10-28T09:00:00.000Z");
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));
  workspaceDir = path.join(stateDir, "ws");
  fs.mkdirSync(workspaceDir);
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("catch-up brief", () => {
  it("remembers when the last session ended", () => {
    markSessionStop({ stateDir, now: new Date("2026-10-28T06:00:00.000Z") });
    expect(markSessionStart({ stateDir, now }).stoppedAt).toBe("2026-10-28T06:00:00.000Z");
  });

  it("leads with overdue commitments and phrases them with the fast brain", async () => {
    markSessionStop({ stateDir, now: new Date("2026-10-28T06:00:00.000Z") });
    markSessionStart({ stateDir, now });
    upsertCommitment(
      {
        text: "Send the deck to Ravi",
        who: "Ravi",
        owner: "sir",
        due: "2026-10-28T08:00:00.000Z",
        source: { kind: "manual", at: now.toISOString() },
      },
      { stateDir, now },
    );
    let prompt = "";
    const brief = await buildCatchupBrief({
      cfg: {} as never,
      workspaceDir,
      stateDir,
      now,
      complete: (async (p: { prompt: string }) => {
        prompt = p.prompt;
        return "Good afternoon, Sir. The deck for Ravi is overdue.";
      }) as never,
    });
    expect(brief.since).toBe("2026-10-28T06:00:00.000Z");
    expect(brief.text).toMatch(/^Since you were last here \(3 h ago\):/);
    expect(brief.items[0].kind).toBe("commitment");
    expect(prompt).toContain("Send the deck to Ravi");
    expect(brief.spoken).toBe("Good afternoon, Sir. The deck for Ravi is overdue.");
  });

  it("falls back to a plain line when the phrasing is unusable", async () => {
    upsertCommitment(
      {
        text: "Pay rent",
        owner: "sir",
        due: "2026-10-28T08:00:00.000Z",
        source: { kind: "manual", at: now.toISOString() },
      },
      { stateDir, now },
    );
    const brief = await buildCatchupBrief({
      cfg: {} as never,
      workspaceDir,
      stateDir,
      now,
      complete: (async () => "As a Gemini model, I suggest...") as never,
    });
    expect(brief.spoken).toMatch(/Pay rent \(OVERDUE since/);
  });

  it("turns today's calendar into agenda items and flags an expired Google sign-in", () => {
    const at = new Date(2026, 9, 28, 9, 0);
    const events = [
      { summary: "Standup", start: new Date(2026, 9, 28, 10, 30).toISOString() },
      { summary: "Tomorrow thing", start: new Date(2026, 9, 29, 10, 0).toISOString() },
      { summary: "Holiday", start: "2026-10-28" },
    ];
    expect(
      calendarItems({ ok: true, text: JSON.stringify(events) }, at).map((i) => i.text),
    ).toEqual([expect.stringMatching(/^Calendar: Standup at 10:30/i), "Calendar: Holiday today"]);
    expect(
      calendarItems({ ok: false, text: "Google sign-in expired (invalid_grant)" }, at)[0].text,
    ).toMatch(/login\.sh/);
    expect(calendarItems({ ok: false, text: "network down" }, at)).toEqual([]);
  });

  it("says so plainly when nothing needs attention", () => {
    expect(plainSpoken([], new Date(2026, 9, 28, 20, 0))).toBe(
      "Good evening, Sir. Nothing urgent while I was off. What are we working on?",
    );
  });
});
