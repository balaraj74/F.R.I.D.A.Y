// Gives a chat a short, model-written title after its first exchange. The title is stored in
// the session's displayName, which deriveSessionTitle already prefers, so the HUD shows it with no
// extra wiring. Failures are silent: the chat simply keeps its derived title.
import type { FRIDAYConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { stripEnvelope } from "./chat-sanitize.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

export const SESSION_TITLE_MODEL =
  process.env.FRIDAY_TITLE_MODEL?.trim() || "gemini-3.5-flash-lite";
const PROVIDER = "antigravity-proxy";
const TITLE_TIMEOUT_MS = 20_000;
const TITLE_MAX_LEN = 50;
const SKIP_KEY_PARTS = [":cron:", ":subagent:", ":eval:", ":test"];

type Block = { type?: string; text?: string };
type Msg = { role?: string; content?: unknown };

function textOf(message: Msg): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as Block[])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join(" ");
}

/** Cleans a model reply into a one-line title, or "" if nothing usable is left. */
export function cleanGeneratedTitle(raw: string): string {
  let t = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  t = t
    .replace(/^\s*(title\s*[:\-]\s*)/i, "")
    .replace(/^["'`“”‘’*#\s]+|["'`“”‘’*\s.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > TITLE_MAX_LEN) {
    t = t.slice(0, TITLE_MAX_LEN).replace(/\s+\S*$/, "").trim();
  }
  return t;
}

export async function requestSessionTitle(params: {
  cfg: FRIDAYConfig;
  userText: string;
  assistantText: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const provider = params.cfg.models?.providers?.[PROVIDER] as
    | { baseUrl?: string; apiKey?: string }
    | undefined;
  const baseUrl = (provider?.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");
  const prompt =
    "Write a title for this chat in 3 to 6 words. Use plain words that name the topic. " +
    "No quotes, no trailing period, no emoji. Reply with the title only.\n\n" +
    `User: ${params.userText.slice(0, 600)}\n\nAssistant: ${params.assistantText.slice(0, 600)}`;
  const res = await (params.fetchImpl ?? fetch)(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider?.apiKey ?? "test",
    },
    body: JSON.stringify({
      model: SESSION_TITLE_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
    signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`title request failed (HTTP ${res.status})`);
  const body = (await res.json()) as { content?: Block[] };
  const text = (body.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join(" ");
  return cleanGeneratedTitle(text);
}

const inFlight = new Set<string>();

/** Fire-and-forget: titles the chat once, after its first user and assistant messages exist. */
export async function maybeGenerateSessionTitle(params: {
  sessionKey: string;
  fetchImpl?: typeof fetch;
  onTitled?: (title: string) => void;
}): Promise<string | null> {
  const { sessionKey } = params;
  if (SKIP_KEY_PARTS.some((part) => sessionKey.includes(part))) return null;
  if (inFlight.has(sessionKey)) return null;
  inFlight.add(sessionKey);
  try {
    const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId || entry.displayName?.trim()) return null;
    const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile) as Msg[];
    const firstUser = messages.find((m) => m.role === "user");
    const firstAssistant = messages.find((m) => m.role === "assistant" && textOf(m).trim());
    if (!firstUser || !firstAssistant) return null;
    const userText = stripEnvelope(textOf(firstUser)).trim();
    const assistantText = textOf(firstAssistant).trim();
    if (!userText) return null;
    const title = await requestSessionTitle({
      cfg,
      userText,
      assistantText,
      fetchImpl: params.fetchImpl,
    });
    if (!title) return null;
    let saved = false;
    await updateSessionStore(storePath, (store) => {
      const current = store[canonicalKey];
      // Re-check: the chat may have been reset, retitled or deleted while the model worked.
      if (!current || current.sessionId !== entry.sessionId || current.displayName?.trim()) return;
      current.displayName = title;
      saved = true;
    });
    if (saved) params.onTitled?.(title);
    return saved ? title : null;
  } catch {
    return null;
  } finally {
    inFlight.delete(sessionKey);
  }
}

// Kept so tests and callers can read the store without importing config internals.
export function readSessionTitle(sessionKey: string): string | undefined {
  const { storePath, canonicalKey } = loadSessionEntry(sessionKey);
  return loadSessionStore(storePath)[canonicalKey]?.displayName;
}
