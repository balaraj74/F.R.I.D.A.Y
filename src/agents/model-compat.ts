import type { Api, Model } from "@earendil-works/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function isAnthropicHost(baseUrl: string): boolean {
  if (!baseUrl) return true; // built-in Anthropic models carry no baseUrl override
  try {
    return new URL(baseUrl).hostname.endsWith("anthropic.com");
  } catch {
    return false;
  }
}

/**
 * Anthropic-compatible proxies (e.g. the local antigravity proxy) stream thinking blocks without a
 * signature. pi 1.x replays unsigned thinking from history as plain assistant *text* unless
 * `allowEmptySignature` is set, so the model sees its own past reasoning as visible replies and
 * starts writing its reasoning into the answer (the HUD then shows and speaks it). Keep the blocks
 * as thinking for non-Anthropic hosts; real Anthropic requires signatures, so it is left alone.
 */
function withProxyThinkingReplay(model: Model<"anthropic-messages">): Model<Api> {
  if (isAnthropicHost(model.baseUrl ?? "")) return model;
  const compat = model.compat ?? undefined;
  if (compat?.allowEmptySignature !== undefined) return model;
  model.compat = compat ? { ...compat, allowEmptySignature: true } : { allowEmptySignature: true };
  return model;
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  if (isAnthropicMessagesModel(model)) return withProxyThinkingReplay(model);

  const baseUrl = model.baseUrl ?? "";
  const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
  if (!isZai || !isOpenAiCompletionsModel(model)) return model;

  const openaiModel = model as Model<"openai-completions">;
  const compat = openaiModel.compat ?? undefined;
  if (compat?.supportsDeveloperRole === false) return model;

  openaiModel.compat = compat
    ? { ...compat, supportsDeveloperRole: false }
    : { supportsDeveloperRole: false };
  return openaiModel;
}
