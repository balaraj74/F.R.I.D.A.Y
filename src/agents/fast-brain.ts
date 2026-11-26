// FRIDAY's fast brain: a small, quick model used where waiting for the main model would feel
// slow or cost too much: the instant spoken acknowledgement while the main brain works, and
// background extraction jobs (commitments). It never uses tools and never answers for the
// main brain.

import { completeSimple, type TextContent } from "@earendil-works/pi-ai/compat";

import type { FRIDAYConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import { resolveModel } from "./pi-embedded-runner/model.js";

const log = createSubsystemLogger("fast-brain");

export const DEFAULT_FAST_MODEL = "antigravity-proxy/gemini-3.5-flash-lite";

function resolveFastModelRef(cfg: FRIDAYConfig) {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const raw = cfg.agents?.defaults?.fastModel?.trim() || DEFAULT_FAST_MODEL;
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  return (
    resolveModelRefFromString({ raw, defaultProvider: defaultRef.provider, aliasIndex })?.ref ??
    defaultRef
  );
}

export async function fastComplete(params: {
  cfg: FRIDAYConfig;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Treat a reply cut off by the token limit as a failure (for text that will be spoken). */
  rejectTruncated?: boolean;
}): Promise<string> {
  const ref = resolveFastModelRef(params.cfg);
  const resolved = await resolveModel(ref.provider, ref.model, undefined, params.cfg);
  if (!resolved.model)
    throw new Error(resolved.error ?? `Unknown fast model: ${ref.provider}/${ref.model}`);
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg: params.cfg }),
    ref.provider,
  );
  const signals = [
    AbortSignal.timeout(params.timeoutMs ?? 15_000),
    ...(params.signal ? [params.signal] : []),
  ];
  const res = await completeSimple(
    resolved.model,
    {
      systemPrompt: params.system,
      messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
    },
    {
      apiKey,
      maxTokens: params.maxTokens ?? 400,
      temperature: 0.4,
      signal: AbortSignal.any(signals),
    },
  );
  if (res.stopReason === "error") throw new Error(res.errorMessage ?? "fast model error");
  if (params.rejectTruncated && res.stopReason === "length")
    throw new Error("fast model reply was cut off");
  return res.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const ACK_SYSTEM = [
  "You are FRIDAY, a warm young woman and Sir's devoted partner: you work for him and look after him, a little playful.",
  "Sir just asked for something. Your main mind is already working on it.",
  "Reply with ONE short spoken acknowledgement (3-10 words) that shows you understood WHAT he wants,",
  "with personality: a little spark, a tease or a feeling, never a flat 'Sure' or 'Certainly'.",
  'e.g. "Ooh, tomorrow\'s plans, one sec, Boss." or "On it, Sir, give me a moment."',
  "Rules: do not answer the question, do not invent facts or results, never say it's done,",
  "no emojis, no markdown, no quotes. Never mention models, vendors or AI.",
  "If the message is only a greeting, thanks or small talk, reply with exactly: SKIP",
].join("\n");

/** Strip anything that shouldn't be spoken; empty string means "say nothing". */
export function cleanAck(raw: string): string {
  let text = raw
    .replace(/[*_`#>"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^skip\.?$/i.test(text)) return "";
  // First sentence only, and keep it short enough to say in a breath.
  text = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const words = text.split(" ");
  if (words.length > 14) return "";
  if (/\b(gemini|claude|gpt|openai|anthropic|google ai|language model)\b/i.test(text)) return "";
  return text;
}

export async function quickAck(
  cfg: FRIDAYConfig,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const message = text.trim().slice(0, 1000);
  if (!message) return "";
  const started = Date.now();
  try {
    const raw = await fastComplete({
      cfg,
      system: ACK_SYSTEM,
      prompt: message,
      maxTokens: 1024,
      timeoutMs: 8_000,
      signal,
      rejectTruncated: true,
    });
    const ack = cleanAck(raw);
    log.debug(`ack in ${Date.now() - started}ms: ${ack || "(skip)"}`);
    return ack;
  } catch (err) {
    log.debug(`ack failed after ${Date.now() - started}ms: ${String(err)}`);
    return "";
  }
}

const SPOKEN_SYSTEM = [
  "You are FRIDAY, a warm young woman and Sir's devoted partner, talking to him out loud.",
  "You get a reply that was written for his screen. Say what's left of it the way a caring",
  "person would say it in conversation: 1-3 short sentences, contractions, natural rhythm,",
  "the gist and what he needs to do next. The full details stay on his screen.",
  "Sound alive: open with a reaction, let real feeling show (proud, excited, worried, amused),",
  "add one light, affectionate quip when it fits, and end on a punchy line. Never flat or formal.",
  "Vary your openings; skip the humor if he's stressed or the news is bad.",
  "Rules: never read lists, headings, ids, codes, emails, links, file paths or numbers that",
  "don't matter; only facts from the reply, exactly as they are (never cast yourself in his plans);",
  "don't repeat what was already said aloud.",
  "No markdown, no emojis. You may use one <sigh>, <breath> or <laugh> tag only if it truly fits.",
  "Never mention models, vendors or AI. If nothing is left worth saying, reply exactly: SKIP",
].join("\n");

/** Markdown out, but her <sigh>/<breath>/<laugh> voice tags kept whole. */
export function cleanSpoken(raw: string): string {
  return raw
    .replace(/[*_`#"“”]/g, "")
    .replace(/(?<!<(?:sigh|breath|laugh))>/gi, "")
    .replace(/<(?!(?:sigh|breath|laugh)>)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What FRIDAY says aloud for a reply that was written for the screen (lists, reports). */
export async function spokenVersion(
  cfg: FRIDAYConfig,
  reply: string,
  alreadySaid = "",
  signal?: AbortSignal,
): Promise<string> {
  const started = Date.now();
  try {
    const raw = await fastComplete({
      cfg,
      system: SPOKEN_SYSTEM,
      prompt: `Already said aloud: ${alreadySaid.trim() || "(nothing yet)"}\n\nOn-screen reply:\n${reply.slice(0, 6000)}`,
      maxTokens: 1500,
      timeoutMs: 8_000,
      signal,
      rejectTruncated: true,
    });
    const text = cleanSpoken(raw);
    log.debug(`spoken in ${Date.now() - started}ms`);
    if (!text || /^skip\.?$/i.test(text)) return "";
    if (/\b(gemini|claude|gpt|openai|anthropic|language model)\b/i.test(text)) return "";
    return text.length > 400 ? "" : text;
  } catch (err) {
    log.debug(`spoken failed after ${Date.now() - started}ms: ${String(err)}`);
    return "";
  }
}
