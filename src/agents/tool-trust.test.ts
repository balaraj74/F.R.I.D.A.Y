import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTrust, readAutonomousActions, setGrant } from "../infra/autonomy-trust.js";
import { isMessageToSir, wrapToolWithTrust } from "./tool-trust.js";
import type { AnyAgentTool } from "./tools/common.js";

let state: string;
let workspace: string;
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "tool-trust-"));
  workspace = path.join(state, "ws");
  fs.mkdirSync(workspace);
  vi.stubEnv("FRIDAY_STATE_DIR", state);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(state, { recursive: true, force: true });
});

const tool = (name: string, result: unknown = { content: [], details: {} }) =>
  ({
    name,
    label: name,
    description: "",
    parameters: {},
    execute: vi.fn(async () => result),
  }) as unknown as AnyAgentTool;
const cfg = { agents: { defaults: { heartbeat: { to: "+91 99999 00001" } } } } as never;
let auto: { config: never; messageProvider: string; sessionKey: string; workspaceDir: string };
let direct: typeof auto;
beforeEach(() => {
  auto = {
    config: cfg,
    messageProvider: "heartbeat",
    sessionKey: "agent:main:main",
    workspaceDir: workspace,
  };
  direct = { ...auto, messageProvider: "webchat" };
});

describe("wrapToolWithTrust", () => {
  it("records exec outcomes and logs autonomous ones with undo hints", async () => {
    const exec = tool("exec", {
      content: [],
      details: { status: "completed", exitCode: 0, aggregated: "", cwd: "/x" },
    });
    await wrapToolWithTrust(exec, direct).execute("1", { command: "systemctl --user start foo" });
    await wrapToolWithTrust(exec, auto).execute("2", { command: "systemctl --user start foo" });
    expect(loadTrust().kinds["systemctl start"]).toMatchObject({ ok: 2, streak: 2 });
    const actions = readAutonomousActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      what: "systemctl --user start foo",
      undo: "systemctl --user stop foo",
    });
  });

  it("never looks at or controls Sir's screen on her own, even when granted", async () => {
    const look = tool("mcp_desktop_screen_look");
    const click = tool("mcp_desktop_screen_click");
    setGrant("screen:look", true);
    setGrant("mcp:desktop", true);
    await expect(wrapToolWithTrust(look, auto).execute("1", {})).rejects.toThrow(
      /looks at Sir's screen/,
    );
    await expect(wrapToolWithTrust(click, auto).execute("2", { x: 1, y: 1 })).rejects.toThrow(
      /mouse and keyboard/,
    );
    expect(look.execute).not.toHaveBeenCalled();
    expect(click.execute).not.toHaveBeenCalled();
    // When Sir asks, both just work.
    await wrapToolWithTrust(look, direct).execute("3", {});
    await wrapToolWithTrust(click, direct).execute("4", { x: 1, y: 1 });
    expect(look.execute).toHaveBeenCalledTimes(1);
    expect(click.execute).toHaveBeenCalledTimes(1);
  });

  it("never merges or discards code on her own; tests need earned trust", async () => {
    const code = tool("code");
    await expect(
      wrapToolWithTrust(code, auto).execute("1", { action: "merge", id: "x" }),
    ).rejects.toThrow(/changes Sir's own branches/);
    await expect(
      wrapToolWithTrust(code, auto).execute("2", { action: "test", id: "x" }),
    ).rejects.toThrow(/hasn't earned trust/);
    await wrapToolWithTrust(code, auto).execute("3", { action: "review", id: "x" });
    setGrant("code:test", true);
    await wrapToolWithTrust(code, auto).execute("4", { action: "test", id: "x" });
    await wrapToolWithTrust(code, direct).execute("5", { action: "merge", id: "x" });
    expect(code.execute).toHaveBeenCalledTimes(3);
  });

  it("lets Serena open only FRIDAY's own task copies", async () => {
    const activate = tool("mcp_serena_activate_project");
    await expect(
      wrapToolWithTrust(activate, direct).execute("1", {
        project: "/home/sir/projects/careerlens",
      }),
    ).rejects.toThrow(/task copies/);
    await expect(
      wrapToolWithTrust(activate, direct).execute("2", {
        project: path.join(workspace, "code", "..", "x"),
      }),
    ).rejects.toThrow(/task copies/);
    await wrapToolWithTrust(activate, direct).execute("3", {
      project: path.join(workspace, "code", "careerlens-fix"),
    });
    expect(activate.execute).toHaveBeenCalledTimes(1);
  });

  it("runs Sir's automations on her own only once trusted", async () => {
    const automations = tool("automations");
    await expect(
      wrapToolWithTrust(automations, auto).execute("1", { action: "trigger", path: "x" }),
    ).rejects.toThrow(/hasn't earned trust/);
    await wrapToolWithTrust(automations, auto).execute("2", { action: "list" });
    setGrant("n8n:trigger", true);
    await wrapToolWithTrust(automations, auto).execute("3", { action: "trigger", path: "x" });
    expect(automations.execute).toHaveBeenCalledTimes(2);
  });

  it("never changes which folders she reads on her own", async () => {
    const files = tool("files");
    await expect(
      wrapToolWithTrust(files, auto).execute("1", { action: "add_folder", folder: "/x" }),
    ).rejects.toThrow(/only Sir chooses/);
    await wrapToolWithTrust(files, auto).execute("2", { action: "search", query: "x" });
    await wrapToolWithTrust(files, direct).execute("3", { action: "add_folder", folder: "/x" });
    expect(files.execute).toHaveBeenCalledTimes(2);
  });

  it("lets autonomous runs write in the workspace but not elsewhere until trusted", async () => {
    const write = tool("write");
    await wrapToolWithTrust(write, auto).execute("1", { path: "memory/today.md", content: "x" });
    const outside = path.join(state, "outside.txt");
    await expect(
      wrapToolWithTrust(write, auto).execute("2", { path: outside, content: "x" }),
    ).rejects.toThrow(/hasn't earned trust/);
    setGrant("file:write", true);
    fs.writeFileSync(outside, "old");
    await wrapToolWithTrust(write, auto).execute("3", { path: outside, content: "x" });
    const [action] = readAutonomousActions();
    expect(action.snapshot && fs.readFileSync(path.join(action.snapshot, "content"), "utf-8")).toBe(
      "old",
    );
  });

  it("never lets autonomous runs message anyone but Sir", async () => {
    const message = tool("message");
    await wrapToolWithTrust(message, auto).execute("1", { action: "send", message: "hi" });
    await wrapToolWithTrust(message, auto).execute("2", {
      action: "send",
      target: "+919999900001",
      message: "hi",
    });
    await expect(
      wrapToolWithTrust(message, auto).execute("3", {
        action: "send",
        target: "+919999999999",
        message: "hi",
      }),
    ).rejects.toThrow(/other than Sir/);
    // Sir asking directly is his call.
    await wrapToolWithTrust(message, direct).execute("4", {
      action: "send",
      target: "+919999999999",
      message: "hi",
    });
  });

  it("blocks unattended website actions but allows reading pages", async () => {
    const { markToolReadOnly } = await import("./tool-traits.js");
    const click = { ...tool("mcp_browser_click"), label: "browser: browser_click" } as AnyAgentTool;
    const snap = {
      ...tool("mcp_browser_snapshot"),
      label: "browser: browser_snapshot",
    } as AnyAgentTool;
    markToolReadOnly("mcp_browser_snapshot", true);
    await expect(wrapToolWithTrust(click, auto).execute("1", { ref: "e1" })).rejects.toThrow(
      /acts on websites/,
    );
    setGrant("mcp:browser", true); // even a grant can't unlock it
    await expect(wrapToolWithTrust(click, auto).execute("2", { ref: "e1" })).rejects.toThrow(
      /acts on websites/,
    );
    await wrapToolWithTrust(snap, auto).execute("3", {});
    await wrapToolWithTrust(click, direct).execute("4", { ref: "e1" }); // Sir asked: fine
    markToolReadOnly("mcp_browser_snapshot", false);
  });

  it("never lets autonomous runs send email through MCP, even when the server is trusted", async () => {
    setGrant("mcp:google", true);
    const send = { ...tool("mcp_google_gmail_send"), label: "google: gmail_send" } as AnyAgentTool;
    const event = {
      ...tool("mcp_google_calendar_create_event"),
      label: "google: calendar_create_event",
    } as AnyAgentTool;
    await expect(wrapToolWithTrust(send, auto).execute("1", { to: "x@y.z" })).rejects.toThrow(
      /sends, replies/,
    );
    await wrapToolWithTrust(event, auto).execute("2", {}); // trusted server, non-sending action
  });

  it("matches Sir's number however it's formatted", () => {
    expect(isMessageToSir({ target: "919999900001" }, cfg)).toBe(true);
    expect(isMessageToSir({ targets: ["+919999900001", "+911111111111"] }, cfg)).toBe(false);
  });
});
