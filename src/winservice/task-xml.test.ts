import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { launcherVbs, quoteArg, taskXml } from "./task-xml.mjs";
// @ts-expect-error plain ESM module without types
import { buildInstall, formatStatus } from "../../scripts/friday-service.mjs";

describe("task xml", () => {
  const xml = taskXml({
    command: "wscript.exe",
    args: ["//B", "C:\\Users\\Zoë & Co\\a b.vbs"],
    workDir: "C:\\friday",
    userId: "PC\\Zoë",
  });

  it("is a logon task, run as the user without elevation, hidden", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<UserId>PC\\Zoë</UserId>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  it("escapes XML and quotes arguments with spaces", () => {
    expect(xml).toContain(
      "<Arguments>//B &quot;C:\\Users\\Zoë &amp; Co\\a b.vbs&quot;</Arguments>",
    );
    expect(quoteArg("plain")).toBe("plain");
    expect(quoteArg("a b")).toBe('"a b"');
  });

  it("launcher runs hidden (window style 0) and doubles quotes for VBScript", () => {
    const vbs = launcherVbs({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\f r\\s.mjs"],
    });
    expect(vbs).toContain('sh.Run "');
    expect(vbs).toContain('""C:\\Program Files\\nodejs\\node.exe"" ""C:\\f r\\s.mjs""');
    expect(vbs).toContain(", 0, False");
  });

  it("buildInstall wires the launcher into the task", () => {
    const b = buildInstall({
      home: "C:\\Users\\F",
      node: "C:\\n\\node.exe",
      repo: "C:\\friday",
      userId: "PC\\F",
    });
    expect(b.vbs).toContain("src\\winservice\\supervisor.mjs");
    expect(b.xml).toContain("supervisor-launch.vbs");
  });

  it("formatStatus lists state and port, and shows stale 'running' as stopped", () => {
    const s = {
      services: {
        proxy: { state: "running", port: 8080 },
        gateway: { state: "failed", port: 18789, reason: "x" },
      },
    };
    expect(formatStatus(s, true)).toMatch(/proxy\s+running\s+port 8080/);
    expect(formatStatus(s, false)).toMatch(/proxy\s+stopped/);
    expect(formatStatus(s, true)).toMatch(/gateway\s+failed\s+port 18789\s+\(x\)/);
  });
});
