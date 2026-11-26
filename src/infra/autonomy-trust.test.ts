import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkTrust,
  commandKinds,
  isAutonomousRun,
  logAutonomousAction,
  markBriefSent,
  morningBrief,
  recordOutcome,
  setGrant,
  snapshotFile,
  TRUST_THRESHOLD,
  undoAction,
  undoHint,
} from "./autonomy-trust.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("commandKinds", () => {
  it("ignores read-only commands", () => {
    expect(commandKinds("ls -la && git status && cat x | grep y")).toEqual([]);
    expect(commandKinds("systemctl --user status friday-widget")).toEqual([]);
    expect(commandKinds("find . -name '*.ts' | wc -l")).toEqual([]);
    expect(commandKinds("sed -n 1,5p file")).toEqual([]);
    expect(commandKinds("curl -s https://example.com")).toEqual([]);
  });
  it("names mutating kinds", () => {
    expect(commandKinds("git add -A && git commit -m x")).toEqual(["git add", "git commit"]);
    expect(commandKinds("sudo systemctl --user restart friday-widget")).toEqual([
      "systemctl restart",
    ]);
    expect(commandKinds("find /tmp -name x -delete")).toEqual(["find"]);
    expect(commandKinds("sed -i s/a/b/ f")).toEqual(["sed"]);
    expect(commandKinds("curl -X POST https://api -d '{}'")).toEqual(["net:send"]);
    expect(commandKinds("echo $(touch f)")).toEqual(["touch"]);
  });
});

describe("trust", () => {
  it("earns autonomy after a clean streak and loses it on failure", () => {
    for (let i = 0; i < TRUST_THRESHOLD - 1; i++)
      recordOutcome(["git commit"], true, { stateDir: dir });
    expect(checkTrust(["git commit"], dir)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("4/5"),
    });
    recordOutcome(["git commit"], true, { stateDir: dir });
    expect(checkTrust(["git commit"], dir)).toEqual({ allowed: true });
    recordOutcome(["git commit"], false, { stateDir: dir });
    expect(checkTrust(["git commit"], dir).allowed).toBe(false);
  });
  it("never auto-promotes pushes, publishing, or network sends, even when granted", () => {
    for (let i = 0; i < 20; i++) recordOutcome(["git push"], true, { stateDir: dir });
    expect(checkTrust(["git push"], dir)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("always needs"),
    });
    expect(checkTrust(["net:send"], dir).allowed).toBe(false);
  });
  it("supports grant and revoke", () => {
    setGrant("systemctl restart", true, dir);
    expect(checkTrust(["systemctl restart"], dir).allowed).toBe(true);
    setGrant("systemctl restart", false, dir);
    expect(checkTrust(["systemctl restart"], dir)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("revoked"),
    });
  });
  it("needs every kind in a command to be trusted", () => {
    setGrant("git add", true, dir);
    expect(checkTrust(["git add", "git commit"], dir)).toMatchObject({
      allowed: false,
      kind: "git commit",
    });
  });
  it("detects autonomous runs", () => {
    expect(isAutonomousRun({ messageProvider: "heartbeat" })).toBe(true);
    expect(isAutonomousRun({ sessionKey: "agent:main:cron:daily" })).toBe(true);
    expect(isAutonomousRun({ sessionKey: "agent:main:job:j_1a2b3c4d" })).toBe(true);
    expect(isAutonomousRun({ sessionKey: "agent:main:jobsearch" })).toBe(false);
    expect(isAutonomousRun({ messageProvider: "webchat", sessionKey: "agent:main:main" })).toBe(
      false,
    );
    expect(isAutonomousRun({ sessionKey: "agent:main:subagent:auto-swarm-ab12-research" })).toBe(
      true,
    );
    expect(isAutonomousRun({ sessionKey: "agent:main:subagent:swarm-ab12-research" })).toBe(false);
  });
});

describe("undo and brief", () => {
  it("derives undo hints", () => {
    expect(undoHint("git commit -m x", "[main 1a2b3c4] x\n 1 file changed", "/repo")).toBe(
      "git -C /repo revert 1a2b3c4",
    );
    expect(undoHint("systemctl --user start foo", "")).toBe("systemctl --user stop foo");
    expect(undoHint("pip install requests", "")).toBe("pip uninstall -y requests");
    expect(undoHint("rm -rf x", "")).toBeUndefined();
  });
  it("restores a snapshotted file", () => {
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "before");
    const snap = snapshotFile("a_1", file, dir);
    fs.writeFileSync(file, "after");
    logAutonomousAction(
      {
        id: "a_1",
        at: new Date().toISOString(),
        kinds: ["file:write"],
        what: "write",
        ok: true,
        snapshot: snap,
      },
      dir,
    );
    expect(undoAction("a_1", dir)).toContain("Restored");
    expect(fs.readFileSync(file, "utf-8")).toBe("before");
  });
  it("lists actions since the last brief, once", () => {
    const now = new Date();
    logAutonomousAction(
      {
        id: "a_2",
        at: now.toISOString(),
        kinds: ["systemctl start"],
        what: "systemctl start x",
        ok: true,
        undo: "systemctl stop x",
      },
      dir,
    );
    const brief = morningBrief({ stateDir: dir, now });
    expect(brief.count).toBe(1);
    expect(brief.text).toContain("undo: systemctl stop x");
    markBriefSent({ stateDir: dir, now: new Date(now.getTime() + 1000) });
    expect(morningBrief({ stateDir: dir, now: new Date(now.getTime() + 2000) }).count).toBe(0);
  });
});
