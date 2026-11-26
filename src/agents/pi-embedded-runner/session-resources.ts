import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type InlineExtension,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * FRIDAY builds its own system prompt, skills and context files, so pi must not discover any of
 * its own (no AGENTS.md from the workspace, no ~/.pi skills/extensions/themes). Only FRIDAY's
 * extension files (compaction safeguard, context pruning) and inline extensions are loaded.
 */
export async function createEmbeddedResourceLoader(params: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt: string;
  additionalExtensionPaths: string[];
  extensionFactories?: InlineExtension[];
}): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager: params.settingsManager,
    systemPrompt: params.systemPrompt,
    additionalExtensionPaths: params.additionalExtensionPaths,
    extensionFactories: params.extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

export function visibleMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => (message as { role?: string }).role !== "system");
}

/**
 * pi 0.49 let FRIDAY swap the agent's history for a sanitized, turn-limited copy
 * (`agent.replaceMessages`). In pi 1.x the SessionManager is canonical, so the same view is applied
 * per request with a `context` handler instead: the first `priorCount` visible messages (the history
 * the run started with) are replaced by `getHistory()`, and messages added during the run are kept.
 * The saved transcript is untouched, as before. After a compaction the prefix no longer matches,
 * so the override switches itself off and pi's compacted context is used as-is.
 */
/** Context usage below this share means a truncated reply was not caused by a full context. */
const TRUNCATION_COMPACT_MAX_SHARE = 0.8;

type BranchEntry = { type?: string; message?: { role?: string; stopReason?: string } };

function lastAssistantStopReason(entries: readonly unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as BranchEntry;
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return entry.message.stopReason;
    }
  }
  return undefined;
}

/**
 * pi treats a reply cut off at the output limit ("length") as a squeezed context when the
 * output is below the model's configured maxTokens, and compacts the whole conversation before
 * retrying. Proxies such as antigravity cap Gemini output far lower (16k) than the model entry
 * says, so a long `write` call gets cut, pi summarises away the user's detailed request, and the
 * model restarts from the summary again and again. Skip that compaction when the context is not
 * actually near full; the runner then asks the model to split the work (see run.ts).
 */
export function createTruncationGuardExtension(onBlocked?: () => void): InlineExtension {
  return {
    name: "friday-truncation-guard",
    factory: (pi: ExtensionAPI) => {
      pi.on("session_before_compact", (event, ctx) => {
        if (event.reason !== "overflow") return undefined;
        if (lastAssistantStopReason(event.branchEntries) !== "length") return undefined;
        const usage = ctx.getContextUsage();
        const share =
          usage && usage.tokens !== null && usage.contextWindow > 0
            ? usage.tokens / usage.contextWindow
            : undefined;
        if (share !== undefined && share >= TRUNCATION_COMPACT_MAX_SHARE) return undefined;
        onBlocked?.();
        return { cancel: true };
      });
    },
  };
}

export type HistoryView = { priorCount: number; history: AgentMessage[] };

/** `getView` is read per request; it returns undefined until the runner has computed the view. */
export function createHistoryViewExtension(
  getView: () => HistoryView | undefined,
): InlineExtension {
  return {
    name: "friday-history-view",
    factory: (pi: ExtensionAPI) => {
      let active = true;
      pi.on("session_compact", () => {
        active = false;
      });
      pi.on("context", (event) => {
        const view = getView();
        if (!active || !view) return undefined;
        if (event.messages.length < view.priorCount) return undefined;
        return { messages: [...view.history, ...event.messages.slice(view.priorCount)] };
      });
    },
  };
}
