import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { CONFIG_DIR } from "../../utils.js";

/**
 * Gemini 3 (through the antigravity proxy) needs the opaque `thoughtSignature` of every earlier
 * function call when history is replayed. The proxy sends it on each `tool_use` block, but pi
 * drops unknown fields, so FRIDAY's transcripts never kept it; the proxy fell back to an
 * in-memory cache that is lost whenever the proxy restarts. Without signatures the proxy sends a
 * "skip validation" placeholder, and on long tool-heavy chats Gemini then answers with nothing —
 * FRIDAY saw an empty reply, retried, and every message took twice as long.
 *
 * This extension (1) remembers signatures as they stream in, on disk, and puts them back on
 * replay; and (2) rewrites any earlier tool call whose signature is unknown (older chats) as plain
 * text, which Gemini accepts. The current turn's own tool calls are never touched.
 */

const MAX_ENTRIES = 20_000;
const MAX_ARGS_CHARS = 400;
const MAX_RESULT_CHARS = 1_500;

type Block = Record<string, unknown> & { type?: string };
type Message = { role?: string; content?: unknown };

class SignatureStore {
  private map = new Map<string, string>();
  private loaded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly file: string) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [id, sig] of Object.entries(data)) this.map.set(id, sig);
    } catch {
      // missing or unreadable: start empty
    }
  }

  get(id: string): string | undefined {
    this.load();
    return this.map.get(id);
  }

  set(id: string, sig: string) {
    this.load();
    if (this.map.get(id) === sig) return;
    this.map.delete(id);
    this.map.set(id, sig);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
        fs.renameSync(tmp, this.file);
      } catch {
        // best effort: a lost write only means older calls get flattened later
      }
    }, 500);
    this.timer.unref?.();
  }
}

let sharedStore: SignatureStore | undefined;
function store(): SignatureStore {
  sharedStore ??= new SignatureStore(path.join(CONFIG_DIR, "state", "gemini-tool-signatures.json"));
  return sharedStore;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function resultText(block: Block): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const part = c as Block;
      return part.type === "text" ? String(part.text ?? "") : `[${String(part.type ?? "content")}]`;
    })
    .join(" ");
}

/** Restore known signatures and flatten unsigned historical tool calls. Exported for tests. */
export function prepareGeminiPayload(
  payload: unknown,
  lookup: (id: string) => string | undefined,
): { payload: unknown; restored: number; flattened: number } {
  const body = payload as { messages?: Message[] } | undefined;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return { payload, restored: 0, flattened: 0 };

  // The last assistant message and everything after it is the turn in progress: keep it native.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  let restored = 0;
  let flattened = 0;
  const flattenedNames = new Map<string, string>();
  const out = messages.map((msg, index) => {
    if (!Array.isArray(msg?.content)) return msg;
    if (msg.role === "assistant") {
      const content = (msg.content as Block[]).map((b) => {
        if (b?.type !== "tool_use" || typeof b.id !== "string") return b;
        if (typeof b.thoughtSignature === "string" && b.thoughtSignature) return b;
        const sig = lookup(b.id);
        if (sig) {
          restored++;
          return { ...b, thoughtSignature: sig };
        }
        if (index >= lastAssistant) return b;
        flattened++;
        flattenedNames.set(b.id, String(b.name ?? "tool"));
        let args = "";
        try {
          args = JSON.stringify(b.input ?? {});
        } catch {
          args = "{}";
        }
        return {
          type: "text",
          text: `[I called ${String(b.name ?? "tool")} ${clip(args, MAX_ARGS_CHARS)}]`,
        };
      });
      return { ...msg, content };
    }
    const content = (msg.content as Block[]).map((b) => {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") return b;
      const name = flattenedNames.get(b.tool_use_id);
      if (!name) return b;
      const verb = b.is_error ? "failed" : "returned";
      return { type: "text", text: `[${name} ${verb}: ${clip(resultText(b), MAX_RESULT_CHARS)}]` };
    });
    return { ...msg, content };
  });
  return { payload: { ...body, messages: out }, restored, flattened };
}

function isGeminiModelId(id: string | undefined): boolean {
  return typeof id === "string" && id.toLowerCase().includes("gemini");
}

export function createGeminiSignatureExtension(params: {
  modelId: string;
  api: string;
  onPrepared?: (info: { restored: number; flattened: number }) => void;
}): InlineExtension | undefined {
  if (params.api !== "anthropic-messages" || !isGeminiModelId(params.modelId)) return undefined;
  return {
    name: "friday-gemini-signatures",
    factory: (pi: ExtensionAPI) => {
      pi.on("provider_stream_event", (event) => {
        const data = event.data as { type?: string; content_block?: Block } | undefined;
        const block = data?.type === "content_block_start" ? data.content_block : undefined;
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.thoughtSignature === "string" &&
          block.thoughtSignature
        ) {
          store().set(block.id, block.thoughtSignature);
        }
      });
      pi.on("before_provider_request", (event) => {
        const result = prepareGeminiPayload(event.payload, (id) => store().get(id));
        if (result.restored || result.flattened) params.onPrepared?.(result);
        return result.payload;
      });
    },
  };
}
