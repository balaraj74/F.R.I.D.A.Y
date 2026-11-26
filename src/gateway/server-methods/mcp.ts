import { mcpManager } from "../../agents/mcp/manager.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const mcpHandlers: GatewayRequestHandlers = {
  // Connection state and tool names for every configured MCP server (picks up config edits).
  "mcp.status": async ({ respond }) => {
    await mcpManager.ensure(loadConfig(), 3_000);
    respond(true, { servers: mcpManager.status() }, undefined);
  },
  "mcp.reconnect": async ({ params, respond }) => {
    const name =
      typeof (params as { name?: unknown })?.name === "string"
        ? (params as { name: string }).name
        : undefined;
    mcpManager.sync(loadConfig());
    if (name && !mcpManager.status().some((s) => s.name === name)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown MCP server: ${name}`),
      );
      return;
    }
    await mcpManager.reconnect(name);
    respond(true, { servers: mcpManager.status() }, undefined);
  },
};
