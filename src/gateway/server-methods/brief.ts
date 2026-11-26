import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { mcpManager } from "../../agents/mcp/manager.js";
import { buildCatchupBrief, calendarItems } from "../../infra/catchup-brief.js";
import type { GatewayRequestHandlers } from "./types.js";

export const briefHandlers: GatewayRequestHandlers = {
  // What came due or happened while FRIDAY was off: spoken summary + full list.
  "brief.catchup": async ({ respond }) => {
    const cfg = loadConfig();
    const brief = await buildCatchupBrief({
      cfg,
      workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
      // Today's Google Calendar, when the Google MCP server is connected.
      extraItems: async () => {
        // MCP servers connect in the background at start-up; give them a moment.
        await mcpManager.ensure(cfg, 8_000);
        const tool = mcpManager.agentTools().find((t) => t.name === "mcp_google_calendar_upcoming");
        if (!tool) return [];
        try {
          const res = await tool.execute("brief", { days: 1, max_results: 20 });
          const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
          return calendarItems({ ok: true, text });
        } catch (err) {
          return calendarItems({ ok: false, text: String(err) });
        }
      },
    });
    respond(true, brief, undefined);
  },
};
