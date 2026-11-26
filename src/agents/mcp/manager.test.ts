import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { toolTraits } from "../tool-traits.js";
import { convertMcpContent, matches, mcpManager, mcpToolName } from "./manager.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test-fixtures",
  "echo-server.mjs",
);
const local = (label: string, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [fixture, label],
  ...extra,
});

describe("mcpToolName", () => {
  it("prefixes server and sanitises", () => {
    expect(mcpToolName("git hub", "list.issues")).toBe("mcp_git_hub_list_issues");
  });
  it("drops a tool prefix that repeats the server name", () => {
    expect(mcpToolName("browser", "browser_click")).toBe("mcp_browser_click");
    expect(mcpToolName("browser", "browser_")).toBe("mcp_browser_browser_");
  });
  it("caps length with a stable hash", () => {
    const name = mcpToolName("server", "x".repeat(100));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(mcpToolName("server", "x".repeat(100)));
  });
});

describe("tool patterns", () => {
  it("matches exact names, everything, or a prefix", () => {
    expect(matches(["get_file"], "get_file")).toBe(true);
    expect(matches(["*"], "anything")).toBe(true);
    expect(matches(["find_*"], "find_symbol")).toBe(true);
    expect(matches(["find_*"], "refind_symbol")).toBe(false);
    expect(matches(undefined, "x")).toBe(false);
  });
});

describe("convertMcpContent", () => {
  it("keeps text and images, summarises the rest", () => {
    const out = convertMcpContent([
      { type: "text", text: "hi" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a", text: "body" } },
      { type: "audio", mimeType: "audio/wav" },
    ]);
    expect(out).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "body" },
      { type: "text", text: "[audio content omitted]" },
    ]);
  });
});

describe("mcpManager (stdio)", () => {
  afterEach(async () => {
    await mcpManager.closeAll();
  });

  it("connects several servers at once and calls their tools", async () => {
    await mcpManager.ensure(
      {
        mcp: {
          servers: {
            one: local("one", { readOnly: ["echo"] }),
            two: local("two", { deny: ["add"] }),
          },
        },
      },
      20_000,
    );
    const status = Object.fromEntries(mcpManager.status().map((s) => [s.name, s]));
    expect(status.one.state).toBe("connected");
    expect(status.two.state).toBe("connected");
    expect(status.one.tools.sort()).toEqual(["mcp_one_add", "mcp_one_echo", "mcp_one_fail"]);
    expect(status.two.tools.sort()).toEqual(["mcp_two_echo", "mcp_two_fail"]);

    const tools = Object.fromEntries(mcpManager.agentTools().map((t) => [t.name, t]));
    const echo = await tools.mcp_two_echo.execute("c1", { text: "hello" });
    expect(echo.content).toEqual([{ type: "text", text: "two:hello" }]);
    const sum = await tools.mcp_one_add.execute("c2", { a: 2, b: 3 });
    expect(sum.content).toEqual([{ type: "text", text: "5" }]);
    await expect(tools.mcp_one_fail.execute("c3", {})).rejects.toThrow("boom");

    expect(toolTraits("mcp_one_echo").risk).toBe("read");
    expect(toolTraits("mcp_one_add").risk).toBe("act");
  }, 30_000);

  it("follows config: removes dropped servers and skips disabled ones", async () => {
    await mcpManager.ensure({ mcp: { servers: { one: local("one"), two: local("two") } } }, 20_000);
    await mcpManager.ensure(
      { mcp: { servers: { one: local("one"), two: { ...local("two"), enabled: false } } } },
      20_000,
    );
    const status = Object.fromEntries(mcpManager.status().map((s) => [s.name, s]));
    expect(status.one.state).toBe("connected");
    expect(status.two.state).toBe("disabled");
    expect(mcpManager.agentTools().every((t) => t.name.startsWith("mcp_one_"))).toBe(true);
    expect(toolTraits("mcp_two_echo").risk).toBe("act");
  }, 30_000);

  it("reports a broken server as an error without affecting the others", async () => {
    await mcpManager.ensure(
      { mcp: { servers: { ok: local("ok"), bad: { command: "/nonexistent/mcp-server" } } } },
      20_000,
    );
    const status = Object.fromEntries(mcpManager.status().map((s) => [s.name, s]));
    expect(status.ok.state).toBe("connected");
    expect(status.bad.state).toBe("error");
    expect(status.bad.error).toBeTruthy();
  }, 30_000);
});
