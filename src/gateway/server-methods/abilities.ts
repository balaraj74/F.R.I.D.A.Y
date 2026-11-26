import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listTasks } from "../../agents/code/worktree.js";
import { loadEvolution } from "../../agents/evolution/engine.js";
import { addRoot, indexStatus, removeRoot, syncIndex } from "../../agents/files/index.js";
import { listJobs } from "../../agents/jobs/store.js";
import { mcpManager } from "../../agents/mcp/manager.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const N8N_URL = process.env.FRIDAY_N8N_URL ?? "http://127.0.0.1:18961";
const SEARXNG_URL = process.env.FRIDAY_SEARXNG_URL ?? "http://127.0.0.1:18960";

const reachable = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );

export const abilitiesHandlers: GatewayRequestHandlers = {
  // What FRIDAY can do right now, from the real state of each part (for the HUD's ABILITIES tab).
  "abilities.status": async ({ respond }) => {
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const [n8n, search] = await Promise.all([
      reachable(`${N8N_URL}/healthz`),
      reachable(`${SEARXNG_URL}/healthz`),
    ]);
    const jobs = listJobs();
    const bench = loadEvolution().benchmarkHistory ?? [];
    respond(
      true,
      {
        plugins: mcpManager
          .status()
          .map((s) => ({ name: s.name, state: s.state, tools: s.tools.length, error: s.error })),
        files: indexStatus(),
        jobs: {
          active: jobs.filter(
            (j) => j.status === "planning" || j.status === "running" || j.status === "waiting",
          ).length,
          recent: jobs.slice(0, 3).map((j) => ({
            id: j.id,
            title: j.title,
            status: j.status,
            done: j.steps.filter((s) => s.status === "done").length,
            total: j.steps.length,
          })),
        },
        code: listTasks(workspaceDir).map((t) => ({
          id: t.id,
          branch: t.branch,
          repo: path.basename(t.repo),
          task: t.task,
        })),
        automations: { up: n8n, url: N8N_URL },
        search: { up: search },
        screen: {
          approved: fs.existsSync(path.join(os.homedir(), ".friday", "desktop", "restore_token")),
        },
        benchmark: {
          latest: bench.at(-1)?.score ?? null,
          previous: bench.length > 1 ? bench.at(-2)!.score : null,
          measurements: bench.length,
        },
      },
      undefined,
    );
  },
  // Only Sir chooses which folders FRIDAY reads (the agent's own tool refuses this when unattended).
  "abilities.files.add": async ({ params, respond }) => {
    try {
      const folder = (params as { folder?: unknown })?.folder;
      if (typeof folder !== "string" || !folder.trim()) throw new Error("folder required");
      addRoot(folder);
      void syncIndex().catch(() => {});
      respond(true, indexStatus(), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((err as Error).message ?? err)),
      );
    }
  },
  "abilities.files.remove": async ({ params, respond }) => {
    try {
      const folder = (params as { folder?: unknown })?.folder;
      if (typeof folder !== "string" || !folder.trim()) throw new Error("folder required");
      removeRoot(folder);
      respond(true, indexStatus(), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String((err as Error).message ?? err)),
      );
    }
  },
};
