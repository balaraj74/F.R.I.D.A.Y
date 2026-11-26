// Tool traits (ROADMAP_V2 B1/B2): what each tool is allowed to have done to it automatically.
//
// - read-only tools are safe to time out, retry on transient failures, and run in parallel;
// - everything else (exec, writes, messages, forgetting) is never retried or parallelised,
//   because doing it twice is not the same as doing it once.
// Hard-never shell commands are handled separately by the exec autonomy policy.

import type { AnyAgentTool } from "./tools/common.js";

export type ToolRisk = "read" | "act";

export type ToolTraits = {
  risk: ToolRisk;
  /** Same call twice has the same effect as once: may be retried and run in parallel. */
  idempotent: boolean;
  /** Give up after this long (read-only tools only; side-effect tools manage their own time). */
  timeoutMs?: number;
  /** Extra attempts after a transient failure. */
  retries: number;
};

const READ_ONLY_TOOLS = new Set([
  "read",
  "ls",
  "find",
  "grep",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "image",
  "sessions_list",
  "sessions_history",
  "session_status",
  "agents_list",
]);

const READ_TRAITS: ToolTraits = { risk: "read", idempotent: true, timeoutMs: 90_000, retries: 2 };
const ACT_TRAITS: ToolTraits = { risk: "act", idempotent: false, retries: 0 };

// Tools registered at runtime (e.g. MCP tools a server's config marks read-only).
const dynamicReadOnly = new Set<string>();

export function markToolReadOnly(name: string, readOnly: boolean): void {
  if (readOnly) dynamicReadOnly.add(name);
  else dynamicReadOnly.delete(name);
}

export function toolTraits(name: string): ToolTraits {
  return READ_ONLY_TOOLS.has(name) || dynamicReadOnly.has(name) ? READ_TRAITS : ACT_TRAITS;
}

/** Network blips, rate limits and upstream 5xx: worth one more try. Logic errors are not. */
export function isTransientToolError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|fetch failed|network error|\b429\b|\b50[234]\b|rate.?limit|temporarily unavailable|timed out/i.test(
    msg,
  );
}

export const MAX_TOOL_RESULT_CHARS = 60_000;
const HEAD_CHARS = 45_000;
const TAIL_CHARS = 10_000;

type TextPart = { type: string; text?: string };

/** Keep the head and tail of oversized text results so one huge output can't flood the context. */
export function capToolResult<T>(result: T, max = MAX_TOOL_RESULT_CHARS): T {
  const parts = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(parts)) return result;
  let changed = false;
  const content = (parts as TextPart[]).map((part) => {
    if (part?.type !== "text" || typeof part.text !== "string" || part.text.length <= max)
      return part;
    changed = true;
    const omitted = part.text.length - HEAD_CHARS - TAIL_CHARS;
    return {
      ...part,
      text: `${part.text.slice(0, HEAD_CHARS)}\n\n…[${omitted} characters omitted to keep context small]…\n\n${part.text.slice(-TAIL_CHARS)}`,
    };
  });
  return changed ? ({ ...(result as object), content } as T) : result;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Apply traits to a tool: timeout + retry-with-backoff for idempotent tools, result size cap for
 * all tools, and a `parallelSafe` flag the agent loop uses to run read-only calls concurrently.
 */
export function wrapToolWithTraits(
  tool: AnyAgentTool,
  opts: { traits?: ToolTraits; backoffMs?: number } = {},
): AnyAgentTool {
  const traits = opts.traits ?? toolTraits(tool.name);
  const backoffMs = opts.backoffMs ?? 500;
  const execute = tool.execute;
  if (!execute) return tool;
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const run = execute(toolCallId, args, signal, onUpdate);
          const result = traits.timeoutMs
            ? await withTimeout(run, traits.timeoutMs, tool.name)
            : await run;
          return capToolResult(result);
        } catch (err) {
          const canRetry =
            traits.idempotent &&
            attempt < traits.retries &&
            !signal?.aborted &&
            isTransientToolError(err);
          if (!canRetry) throw err;
          // Exponential backoff with a little jitter: 0.5s, 1s, …
          await sleep(backoffMs * 2 ** attempt + Math.floor(Math.random() * 100), signal);
        }
      }
    },
  };
  // pi's agent loop runs a batch concurrently only when no call in it is "sequential", so
  // read-only tools opt in to "parallel" and everything else is pinned to "sequential".
  return Object.assign(wrapped, {
    parallelSafe: traits.idempotent,
    executionMode: traits.idempotent ? ("parallel" as const) : ("sequential" as const),
    traits,
  });
}
