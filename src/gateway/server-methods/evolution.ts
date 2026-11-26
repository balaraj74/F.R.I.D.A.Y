import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { decideProposal, loadEvolution, runEvolution } from "../../agents/evolution/engine.js";
import { loadConfig } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const dirs = () => {
  const cfg = loadConfig();
  const agent = resolveDefaultAgentId(cfg);
  return {
    cfg,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agent),
    sessionsDir: resolveSessionTranscriptsDirForAgent(agent),
  };
};

export const evolutionHandlers: GatewayRequestHandlers = {
  "evolution.status": ({ respond }) => respond(true, loadEvolution(), undefined),
  "evolution.run": async ({ respond }) => {
    try {
      const { cfg, workspaceDir, sessionsDir } = dirs();
      const res = await runEvolution({ cfg, workspaceDir, sessionsDir });
      respond(true, { ...res.state, summary: res.summary }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "evolution.decide": ({ params, respond }) => {
    const { id, action } = (params ?? {}) as { id?: unknown; action?: unknown };
    if (
      typeof id !== "string" ||
      (action !== "approve" && action !== "reject" && action !== "undo")
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "evolution.decide needs id and action"),
      );
      return;
    }
    try {
      respond(true, decideProposal({ id, action, workspaceDir: dirs().workspaceDir }), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
};
