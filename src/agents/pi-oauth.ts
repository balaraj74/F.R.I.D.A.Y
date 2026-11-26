import type { OAuthAuth, OAuthCredential, OAuthCredentials } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/**
 * OAuth providers FRIDAY stores in its auth-profile store. pi 0.49 exposed a global
 * `getOAuthApiKey()`/`loginOpenAICodex()`; pi 1.x moved each flow onto its provider object
 * (`provider.auth.oauth.{login,refresh,toAuth}`). This module keeps FRIDAY's call shape.
 *
 * `google-gemini-cli` and `google-antigravity` were removed from pi in 0.71; they stay in the
 * union so stored profiles still type-check, but refreshing them fails with a clear message.
 */
export type OAuthProvider =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "google-gemini-cli"
  | "google-antigravity";

const REFRESH_TIMEOUT_MS = 30_000;

function resolveOAuth(provider: string): OAuthAuth | undefined {
  switch (provider) {
    case "anthropic":
      return anthropicProvider().auth.oauth;
    case "openai-codex":
      return openaiCodexProvider().auth.oauth;
    case "github-copilot":
      return githubCopilotProvider().auth.oauth;
    default:
      return undefined;
  }
}

function asCredential(creds: OAuthCredentials): OAuthCredential {
  return { ...creds, type: "oauth" };
}

/** Strip pi's `type` tag so FRIDAY's store keeps its own credential shape. */
function toPlainCredentials(cred: OAuthCredential): OAuthCredentials {
  const { type: _type, ...rest } = cred;
  return rest as OAuthCredentials;
}

/**
 * Same contract as pi 0.49 `getOAuthApiKey`: refresh when expired, return the request key and
 * the (possibly refreshed) credentials, or null when no credentials exist for the provider.
 */
export async function getOAuthApiKey(
  provider: OAuthProvider,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const current = credentials[provider];
  if (!current) return null;
  const oauth = resolveOAuth(provider);
  if (!oauth) {
    throw new Error(
      `OAuth refresh for "${provider}" is not supported by the pi runtime (removed upstream). ` +
        "Re-authenticate with an API key or another provider.",
    );
  }
  let cred = asCredential(current);
  if (Date.now() >= cred.expires) {
    cred = await oauth.refresh(cred, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
  }
  const auth = await oauth.toAuth(cred);
  return { apiKey: auth.apiKey ?? cred.access, newCredentials: toPlainCredentials(cred) };
}

/** pi 0.49-style callbacks used by FRIDAY's onboarding wizard. */
export type LegacyOAuthCallbacks = {
  onAuth: (event: { url: string; instructions?: string }) => Promise<void> | void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
};

export async function loginOpenAICodex(callbacks: LegacyOAuthCallbacks): Promise<OAuthCredentials> {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) throw new Error("OpenAI Codex OAuth is unavailable in this pi version.");
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const cred = await oauth.login({
    signal: controller.signal,
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        // FRIDAY's wizard only offers the default account choice; take the first option.
        return prompt.options[0]?.id ?? "";
      }
      return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        pending.push(
          Promise.resolve(callbacks.onAuth({ url: event.url, instructions: event.instructions })),
        );
      } else if (event.type === "progress" || event.type === "info") {
        callbacks.onProgress?.(event.message);
      } else if (event.type === "device_code") {
        callbacks.onProgress?.(`Enter code ${event.userCode} at ${event.verificationUri}`);
      }
    },
  });
  await Promise.allSettled(pending);
  return toPlainCredentials(cred);
}
