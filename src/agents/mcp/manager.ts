// MCP connections: FRIDAY keeps one client per configured server (local stdio or remote
// HTTP/SSE), lists its tools, and exposes them to the agent as ordinary tools named
// `mcp_<server>_<tool>`. Connections are long-lived, reconnect with backoff, and follow
// config edits (servers added, changed or removed) without a gateway restart.

import crypto from "node:crypto";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { FRIDAYConfig } from "../../config/config.js";
import type { McpServerConfig } from "../../config/types.mcp.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { VERSION } from "../../version.js";
import { markToolReadOnly } from "../tool-traits.js";
import type { AnyAgentTool } from "../tools/common.js";

const log = createSubsystemLogger("mcp");

const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const TOOL_NAME_MAX = 64;

export type McpServerState = "connecting" | "connected" | "error" | "disabled";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  kind: "stdio" | "http" | "sse";
  tools: string[];
  error?: string;
  connectedAt?: number;
  serverInfo?: { name: string; version: string };
};

type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

type Conn = {
  name: string;
  cfg: McpServerConfig;
  key: string;
  state: McpServerState;
  client?: Client;
  tools: McpTool[];
  agentTools: AnyAgentTool[];
  error?: string;
  connectedAt?: number;
  attempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  closed: boolean;
};

/** `mcp_<server>_<tool>`, restricted to the characters every provider accepts, ≤64 chars. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Servers often prefix their own tools ("browser_click" on server "browser"): don't say it twice.
  const prefix = `${clean(server)}_`;
  const toolPart =
    clean(tool).startsWith(prefix) && clean(tool).length > prefix.length
      ? clean(tool).slice(prefix.length)
      : clean(tool);
  const full = `mcp_${clean(server)}_${toolPart}`;
  if (full.length <= TOOL_NAME_MAX) return full;
  const hash = crypto.createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `${full.slice(0, TOOL_NAME_MAX - 7)}_${hash}`;
}

function kindOf(cfg: McpServerConfig): McpServerStatus["kind"] {
  if (cfg.command) return "stdio";
  return cfg.transport === "sse" ? "sse" : "http";
}

/** Exact tool names, "*" for all, or a prefix ending in "*" ("get_*"). */
export function matches(list: string[] | undefined, name: string): boolean {
  return Boolean(
    list?.some(
      (p) => p === "*" || p === name || (p.endsWith("*") && name.startsWith(p.slice(0, -1))),
    ),
  );
}

function toolVisible(cfg: McpServerConfig, name: string): boolean {
  if (matches(cfg.deny, name)) return false;
  return !cfg.allow?.length || matches(cfg.allow, name);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function createTransport(cfg: McpServerConfig): Transport {
  if (cfg.command) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...getDefaultEnvironment(), ...cfg.env },
      cwd: cfg.cwd,
      stderr: "pipe",
    });
    return transport;
  }
  const url = new URL(cfg.url!);
  const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
  return cfg.transport === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: string; [k: string]: unknown };

/** MCP tool content → agent tool content (text and images; everything else summarised as text). */
export function convertMcpContent(
  content: McpContent[] | undefined,
): AgentToolResult<unknown>["content"] {
  const out: AgentToolResult<unknown>["content"] = [];
  for (const part of content ?? []) {
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      out.push({ type: "image", data: part.data, mimeType: String(part.mimeType ?? "image/png") });
    } else if (part.type === "resource" && part.resource && typeof part.resource === "object") {
      const r = part.resource as { uri: string; text?: string };
      out.push({ type: "text", text: r.text ?? `[resource ${r.uri}]` });
    } else if (part.type === "resource_link") {
      out.push({ type: "text", text: `[resource ${String(part.uri)}]` });
    } else {
      out.push({ type: "text", text: `[${part.type} content omitted]` });
    }
  }
  return out;
}

class McpManager {
  private conns = new Map<string, Conn>();

  /** Bring connections in line with config: connect new/changed servers, drop removed ones. */
  sync(config: FRIDAYConfig | undefined): void {
    const servers = config?.mcp?.servers ?? {};
    for (const [name, conn] of this.conns) {
      const cfg = servers[name];
      if (!cfg || JSON.stringify(cfg) !== conn.key) void this.drop(name);
    }
    for (const [name, cfg] of Object.entries(servers)) {
      if (this.conns.has(name)) continue;
      const conn: Conn = {
        name,
        cfg,
        key: JSON.stringify(cfg),
        state: cfg.enabled === false ? "disabled" : "connecting",
        tools: [],
        agentTools: [],
        attempts: 0,
        closed: false,
      };
      this.conns.set(name, conn);
      if (cfg.enabled !== false) conn.pending = this.connect(conn);
    }
  }

  /** sync(), then wait (bounded) for servers that are still connecting so their tools are ready. */
  async ensure(config: FRIDAYConfig | undefined, waitMs = 10_000): Promise<void> {
    this.sync(config);
    const pending = [...this.conns.values()]
      .map((c) => c.pending)
      .filter(Boolean) as Promise<void>[];
    if (!pending.length) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, waitMs).unref?.()),
    ]);
  }

  /** Tools from every connected server, ready to hand to the agent. */
  agentTools(): AnyAgentTool[] {
    const out: AnyAgentTool[] = [];
    for (const conn of this.conns.values())
      if (conn.state === "connected") out.push(...conn.agentTools);
    return out;
  }

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((c) => {
      const info = c.client?.getServerVersion();
      return {
        name: c.name,
        state: c.state,
        kind: kindOf(c.cfg),
        tools: c.agentTools.map((t) => t.name),
        error: c.error,
        connectedAt: c.connectedAt,
        serverInfo: info ? { name: info.name, version: info.version } : undefined,
      };
    });
  }

  /** Reconnect one server now (or all), e.g. after fixing its credentials. */
  async reconnect(name?: string): Promise<void> {
    const targets = [...this.conns.values()].filter((c) => !name || c.name === name);
    await Promise.allSettled(
      targets.map(async (c) => {
        if (c.cfg.enabled === false) return;
        clearTimeout(c.retryTimer);
        await this.closeClient(c);
        c.closed = false;
        c.attempts = 0;
        c.pending = this.connect(c);
        await c.pending;
      }),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.conns.keys()].map((n) => this.drop(n)));
  }

  private async drop(name: string): Promise<void> {
    const conn = this.conns.get(name);
    if (!conn) return;
    this.conns.delete(name);
    conn.closed = true;
    clearTimeout(conn.retryTimer);
    for (const t of conn.agentTools) markToolReadOnly(t.name, false);
    await this.closeClient(conn);
  }

  private async closeClient(conn: Conn): Promise<void> {
    const client = conn.client;
    conn.client = undefined;
    if (client) await client.close().catch(() => {});
  }

  private async connect(conn: Conn): Promise<void> {
    conn.state = "connecting";
    const client = new Client({ name: "friday", version: VERSION }, { capabilities: {} });
    try {
      const transport = createTransport(conn.cfg);
      const stderr = transport instanceof StdioClientTransport ? transport.stderr : null;
      stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) log.debug(`[${conn.name}] ${line.slice(0, 500)}`);
      });
      client.onclose = () => {
        if (conn.closed || conn.client !== client) return;
        conn.client = undefined;
        this.fail(conn, "connection closed");
      };
      client.onerror = (err) => log.debug(`[${conn.name}] ${String(err)}`);
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `connecting to ${conn.name}`,
      );
      if (conn.closed) {
        await client.close().catch(() => {});
        return;
      }
      conn.client = client;
      await this.refreshTools(conn);
      if (client.getServerCapabilities()?.tools?.listChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          void this.refreshTools(conn).catch((err) =>
            log.warn(`[${conn.name}] tool refresh failed: ${String(err)}`),
          );
        });
      }
      conn.state = "connected";
      conn.error = undefined;
      conn.attempts = 0;
      conn.connectedAt = Date.now();
      log.info(`connected to ${conn.name} (${conn.agentTools.length} tools)`);
    } catch (err) {
      await client.close().catch(() => {});
      if (conn.client === client) conn.client = undefined;
      this.fail(conn, err instanceof Error ? err.message : String(err));
    } finally {
      conn.pending = undefined;
    }
  }

  private fail(conn: Conn, message: string) {
    if (conn.closed) return;
    conn.state = "error";
    conn.error = message;
    conn.attempts += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (conn.attempts - 1));
    log.warn(`${conn.name}: ${message}; retrying in ${Math.round(delay / 1000)}s`);
    clearTimeout(conn.retryTimer);
    conn.retryTimer = setTimeout(() => {
      if (!conn.closed && this.conns.get(conn.name) === conn) conn.pending = this.connect(conn);
    }, delay);
    conn.retryTimer.unref?.();
  }

  private async refreshTools(conn: Conn): Promise<void> {
    const client = conn.client;
    if (!client) return;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    for (const t of conn.agentTools) markToolReadOnly(t.name, false);
    conn.tools = tools.filter((t) => toolVisible(conn.cfg, t.name));
    conn.agentTools = conn.tools.map((t) => this.toAgentTool(conn, t));
  }

  private toAgentTool(conn: Conn, tool: McpTool): AnyAgentTool {
    const name = mcpToolName(conn.name, tool.name);
    markToolReadOnly(name, matches(conn.cfg.readOnly, tool.name));
    const schema =
      tool.inputSchema && typeof tool.inputSchema === "object"
        ? { type: "object", properties: {}, ...tool.inputSchema }
        : { type: "object", properties: {} };
    return {
      name,
      label: `${conn.name}: ${tool.name}`,
      description: `[MCP ${conn.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      execute: async (_toolCallId, params, signal) => {
        const client = conn.client;
        if (!client || conn.state !== "connected") {
          throw new Error(
            `MCP server "${conn.name}" is not connected${conn.error ? ` (${conn.error})` : ""}`,
          );
        }
        const result = await client.callTool(
          { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
          undefined,
          { signal, timeout: conn.cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS },
        );
        const content = convertMcpContent(result.content as McpContent[] | undefined);
        if (!content.length && result.structuredContent) {
          content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
        }
        if (result.isError) {
          const text = content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("\n")
            .trim();
          throw new Error(text || `${conn.name}.${tool.name} failed`);
        }
        return {
          content: content.length ? content : [{ type: "text", text: "(no output)" }],
          details: {
            server: conn.name,
            tool: tool.name,
            structuredContent: result.structuredContent,
          },
        };
      },
    };
  }
}

export const mcpManager = new McpManager();
