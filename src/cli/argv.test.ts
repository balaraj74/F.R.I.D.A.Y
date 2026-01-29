import { describe, expect, it } from "vitest";

import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "friday", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "friday", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "friday", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "friday", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "friday", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "friday", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "friday", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "friday"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "friday", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "friday", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "friday", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "friday", "status", "--timeout=2500"], "--timeout")).toBe("2500");
    expect(getFlagValue(["node", "friday", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "friday", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "friday", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "friday", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "friday", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "friday", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "friday", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "friday", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "friday", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "friday", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node", "friday", "status"],
    });
    expect(nodeArgv).toEqual(["node", "friday", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node-22", "friday", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "friday", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node-22.2.0.exe", "friday", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "friday", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node-22.2", "friday", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "friday", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node-22.2.exe", "friday", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "friday", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["/usr/bin/node-22.2.0", "friday", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "friday", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["nodejs", "friday", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "friday", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["node-dev", "friday", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "friday", "node-dev", "friday", "status"]);

    const directArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["friday", "status"],
    });
    expect(directArgv).toEqual(["node", "friday", "status"]);

    const bunArgv = buildParseArgv({
      programName: "friday",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "friday",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "friday", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "friday", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "friday", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "friday", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "friday", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "friday", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "friday", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "friday", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
