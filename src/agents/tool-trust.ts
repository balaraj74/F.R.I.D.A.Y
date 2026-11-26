// Earned trust at the tool layer: records each action's outcome (building the track record),
// and in autonomous runs (heartbeat/cron) blocks untrusted file writes and messages to anyone
// other than Sir, snapshots files before trusted writes, and logs every action for the morning
// brief. Shell commands are gated inside the exec tool itself (real approval flow).

import path from "node:path";

import type { FRIDAYConfig } from "../config/config.js";
import {
  checkTrust,
  commandKinds,
  isAutonomousRun,
  logAutonomousAction,
  neverAutoReason,
  newActionId,
  recordOutcome,
  snapshotFile,
  undoHint,
} from "../infra/autonomy-trust.js";
import { toolTraits } from "./tool-traits.js";
import type { AnyAgentTool } from "./tools/common.js";

type Ctx = {
  config?: FRIDAYConfig;
  messageProvider?: string;
  sessionKey?: string;
  workspaceDir?: string;
};

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const MESSAGE_READ_ACTIONS =
  /^(read|search|list|info|history|fetch|get|members|channels|emoji-list|pins|thread-list)/;

const digits = (s: string) => s.replace(/\D/g, "");

/** Who counts as Sir on messaging channels: the heartbeat target and the WhatsApp allowlist. */
function sirTargets(cfg?: FRIDAYConfig): string[] {
  const out: string[] = [];
  const hbTo = cfg?.agents?.defaults?.heartbeat?.to;
  if (typeof hbTo === "string") out.push(hbTo);
  const allow = (cfg?.channels as { whatsapp?: { allowFrom?: unknown } } | undefined)?.whatsapp
    ?.allowFrom;
  if (Array.isArray(allow)) out.push(...allow.filter((v): v is string => typeof v === "string"));
  return out;
}

export function isMessageToSir(params: Record<string, unknown>, cfg?: FRIDAYConfig): boolean {
  const targets = [params.target, ...(Array.isArray(params.targets) ? params.targets : [])].filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
  if (!targets.length) return true; // replies go to the current conversation, which is Sir's
  const sir = sirTargets(cfg);
  return targets.every((t) => {
    const d = digits(t);
    return sir.some((s) => s === t || (d.length >= 7 && digits(s) === d));
  });
}

function insideWorkspace(file: string, workspaceDir?: string): boolean {
  if (!workspaceDir) return false;
  const rel = path.relative(path.resolve(workspaceDir), path.resolve(workspaceDir, file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function wrapToolWithTrust(tool: AnyAgentTool, ctx: Ctx): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) return tool;

  // Serena (code understanding and refactoring) only ever opens FRIDAY's own task copies from
  // the code tool, so it can't edit Sir's checkout or leave its files in his repos.
  if (tool.name === "mcp_serena_activate_project") {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const project = String((args as { project?: unknown })?.project ?? "");
        const tasks = ctx.workspaceDir ? path.join(path.resolve(ctx.workspaceDir), "code") : null;
        const abs = path.resolve(project.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
        if (!tasks || !abs.startsWith(`${tasks}${path.sep}`)) {
          throw new Error(
            "Serena works only on your own task copies: use the code tool's start action for this repo, then activate the returned dir.",
          );
        }
        return execute(id, args, signal, onUpdate);
      },
    };
  }
  const autonomous = isAutonomousRun(ctx);
  const name = tool.name;

  if (name === "exec") {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const command = String((args as { command?: unknown })?.command ?? "");
        const kinds = commandKinds(command);
        try {
          const result = await execute(id, args, signal, onUpdate);
          const details = (
            result as {
              details?: {
                status?: string;
                exitCode?: number | null;
                aggregated?: string;
                cwd?: string;
              };
            }
          ).details;
          if (details?.status === "completed" || details?.status === "failed") {
            const ok = details.status === "completed" && (details.exitCode ?? 0) === 0;
            recordOutcome(kinds, ok);
            if (autonomous && kinds.length) {
              logAutonomousAction({
                id: newActionId(),
                at: new Date().toISOString(),
                kinds,
                what: command,
                ok,
                sessionKey: ctx.sessionKey,
                cwd: details.cwd,
                undo: ok ? undoHint(command, details.aggregated ?? "", details.cwd) : undefined,
              });
            }
          }
          return result;
        } catch (err) {
          recordOutcome(kinds, false);
          throw err;
        }
      },
    };
  }

  if (FILE_WRITE_TOOLS.has(name)) {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const file = String(a.path ?? a.file_path ?? "");
        // FRIDAY's own workspace (notes, memory, drafts) is hers to write.
        if (!file || insideWorkspace(file, ctx.workspaceDir))
          return execute(id, args, signal, onUpdate);
        const abs = path.resolve(ctx.workspaceDir ?? process.cwd(), file);
        const actionId = newActionId();
        let snapshot: string | undefined;
        if (autonomous) {
          const check = checkTrust(["file:write"]);
          if (!check.allowed) {
            throw new Error(`Not done: ${check.reason}. Ask Sir before changing ${abs}.`);
          }
          snapshot = snapshotFile(actionId, abs);
        }
        try {
          const result = await execute(id, args, signal, onUpdate);
          recordOutcome(["file:write"], true);
          if (autonomous) {
            logAutonomousAction({
              id: actionId,
              at: new Date().toISOString(),
              kinds: ["file:write"],
              what: `${name} ${abs}`,
              ok: true,
              sessionKey: ctx.sessionKey,
              snapshot,
            });
          }
          return result;
        } catch (err) {
          recordOutcome(["file:write"], false);
          throw err;
        }
      },
    };
  }

  // Sir's screen is private: on her own she never looks at it or uses his mouse and keyboard,
  // even though looking is read-only (both kinds are never-auto, see autonomy-trust.ts).
  if (name.startsWith("mcp_desktop_") && autonomous) {
    const kind = name === "mcp_desktop_screen_look" ? "screen:look" : "mcp:desktop";
    return {
      ...tool,
      execute: async () => {
        throw new Error(
          `Not done: this ${neverAutoReason(kind)}, which only happens when Sir asks.`,
        );
      },
    };
  }

  // Code: unattended she may branch, edit, commit and review; running a project's tests must
  // earn trust like any command, and merging into (or discarding) Sir's work never happens.
  if (name === "code" && autonomous) {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const action = String((args as { action?: unknown })?.action ?? "");
        if (action === "merge" || action === "discard") {
          throw new Error(
            `Not done: \`code:merge\` ${neverAutoReason("code:merge")}. Show Sir the review and ask.`,
          );
        }
        if (action !== "test") return execute(id, args, signal, onUpdate);
        const check = checkTrust(["code:test"]);
        if (!check.allowed) throw new Error(`Not done: ${check.reason}. Ask Sir to run the tests.`);
        const result = await execute(id, args, signal, onUpdate);
        recordOutcome(["code:test"], true);
        return result;
      },
    };
  }

  // Running one of Sir's automations on her own must be earned like any other action.
  if (name === "automations" && autonomous) {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        if (String((args as { action?: unknown })?.action ?? "") !== "trigger")
          return execute(id, args, signal, onUpdate);
        const check = checkTrust(["n8n:trigger"]);
        if (!check.allowed) throw new Error(`Not done: ${check.reason}. Ask Sir first.`);
        try {
          const result = await execute(id, args, signal, onUpdate);
          recordOutcome(["n8n:trigger"], true);
          return result;
        } catch (err) {
          recordOutcome(["n8n:trigger"], false);
          throw err;
        }
      },
    };
  }

  // Which of Sir's folders she reads is his choice, never changed on her own.
  if (name === "files" && autonomous) {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const action = String((args as { action?: unknown })?.action ?? "");
        if (action === "add_folder" || action === "remove_folder")
          throw new Error("Not done: only Sir chooses which folders I read. Ask him.");
        return execute(id, args, signal, onUpdate);
      },
    };
  }

  // MCP tools that change things: on her own, only once the server has earned it
  // (and never for the browser: clicking/typing on websites unattended always waits for Sir).
  if (name.startsWith("mcp_") && autonomous && toolTraits(name).risk !== "read") {
    const server = (tool.label ?? "").split(":")[0]?.trim() || name.split("_")[1] || "unknown";
    // Sending, replying, forwarding or deleting on Sir's behalf never becomes automatic.
    const kind = /_(send|reply|forward|delete|trash)(_|$)/.test(name)
      ? "mcp:send"
      : `mcp:${server}`;
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const check = checkTrust([kind]);
        if (!check.allowed) throw new Error(`Not done: ${check.reason}. Ask Sir first.`);
        try {
          const result = await execute(id, args, signal, onUpdate);
          recordOutcome([kind], true);
          logAutonomousAction({
            id: newActionId(),
            at: new Date().toISOString(),
            kinds: [kind],
            what: `${name} ${JSON.stringify(args ?? {}).slice(0, 100)}`,
            ok: true,
            sessionKey: ctx.sessionKey,
          });
          return result;
        } catch (err) {
          recordOutcome([kind], false);
          throw err;
        }
      },
    };
  }

  if (name === "message" && autonomous) {
    return {
      ...tool,
      execute: async (id, args, signal, onUpdate) => {
        const a = (args ?? {}) as Record<string, unknown>;
        const action = String(a.action ?? "send");
        if (!MESSAGE_READ_ACTIONS.test(action) && !isMessageToSir(a, ctx.config)) {
          throw new Error(
            "Not sent: messaging anyone other than Sir always needs his approval. Draft it and ask him first.",
          );
        }
        const result = await execute(id, args, signal, onUpdate);
        if (!MESSAGE_READ_ACTIONS.test(action)) {
          logAutonomousAction({
            id: newActionId(),
            at: new Date().toISOString(),
            kinds: ["message:sir"],
            what: `message ${action} to Sir: ${String(a.message ?? "").slice(0, 80)}`,
            ok: true,
            sessionKey: ctx.sessionKey,
          });
        }
        return result;
      },
    };
  }

  return tool;
}
