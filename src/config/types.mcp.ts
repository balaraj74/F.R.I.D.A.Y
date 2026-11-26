/** One MCP server FRIDAY connects to. Give either `command` (local stdio) or `url` (remote). */
export type McpServerConfig = {
  /** Set false to keep the entry but not connect. Default: true. */
  enabled?: boolean;
  /** Local server: executable to launch over stdio (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra environment for the local server (values support ${ENV_VAR} substitution). */
  env?: Record<string, string>;
  cwd?: string;
  /** Remote server: MCP endpoint URL. */
  url?: string;
  /** Remote transport. "http" = Streamable HTTP (default), "sse" = legacy SSE. */
  transport?: "http" | "sse";
  /** Extra HTTP headers, e.g. Authorization (values support ${ENV_VAR} substitution). */
  headers?: Record<string, string>;
  /** Only expose these tools (MCP tool names). */
  allow?: string[];
  /** Never expose these tools (MCP tool names). */
  deny?: string[];
  /** Tools that only read: they may be retried, timed out and run in parallel. Use ["*"] for all. */
  readOnly?: string[];
  /** Per-call timeout in ms. Default: 60000. */
  timeoutMs?: number;
};

export type McpConfig = {
  servers?: Record<string, McpServerConfig>;
};
