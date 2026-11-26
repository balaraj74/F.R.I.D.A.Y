import fsSync from "node:fs";

import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import type { FRIDAYConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createGeminiEmbeddingProvider, type GeminiEmbeddingClient } from "./embeddings-gemini.js";
import { createOpenAiEmbeddingProvider, type OpenAiEmbeddingClient } from "./embeddings-openai.js";
import { importNodeLlamaCpp } from "./node-llama.js";

export type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
export type { OpenAiEmbeddingClient } from "./embeddings-openai.js";

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local" | "gemini" | "auto";
  fallbackFrom?: "openai" | "local" | "gemini";
  fallbackReason?: string;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
};

export type EmbeddingProviderOptions = {
  config: FRIDAYConfig;
  agentDir?: string;
  provider: "openai" | "local" | "gemini" | "auto";
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  };
  model: string;
  fallback: "openai" | "gemini" | "local" | "none";
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function canAutoSelectLocal(options: EmbeddingProviderOptions): boolean {
  const modelPath = options.local?.modelPath?.trim();
  if (!modelPath) return false;
  if (/^(hf:|https?:)/i.test(modelPath)) return false;
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isMissingApiKeyError(err: unknown): boolean {
  const message = formatError(err);
  return message.includes("No API key found for provider");
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  // Initialise once: embedBatch calls this concurrently, and parallel first calls used to
  // download/load the model several times (racing on the download's final rename).
  let ready: Promise<{ model: LlamaModel; ctx: LlamaEmbeddingContext; maxTokens: number }> | null =
    null;
  const ensureContext = () => {
    ready ??= (async () => {
      const llama: Llama = await getLlama({ logLevel: LlamaLogLevel.error });
      const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
      const model = await llama.loadModel({ modelPath: resolved });
      const ctx = await model.createEmbeddingContext();
      // Leave room for the special tokens the model adds around the input.
      const maxTokens = Math.max(1, model.trainContextSize - 4);
      return { model, ctx, maxTokens };
    })().catch((err) => {
      ready = null; // allow a retry after a transient failure
      throw err;
    });
    return ready;
  };

  // Small models (e.g. MiniLM, 512 tokens) can't take every chunk: code, URLs and non-Latin
  // text tokenize much denser than the chunker's estimate. Truncate instead of failing the index.
  const embedOne = async (text: string) => {
    const { model, ctx, maxTokens } = await ensureContext();
    const tokens = model.tokenize(text);
    const embedding = await ctx.getEmbeddingFor(
      tokens.length > maxTokens ? tokens.slice(0, maxTokens) : tokens,
    );
    return Array.from(embedding.vector) as number[];
  };

  // EmbeddingGemma is trained with task prompts; without them retrieval quality drops sharply.
  // https://ai.google.dev/gemma/docs/embeddinggemma (query vs. document prompts)
  const usesGemmaPrompts = /embeddinggemma/i.test(modelPath);
  const asQuery = (t: string) => (usesGemmaPrompts ? `task: search result | query: ${t}` : t);
  const asDocument = (t: string) => (usesGemmaPrompts ? `title: none | text: ${t}` : t);

  return {
    id: "local",
    model: modelPath,
    embedQuery: (text) => embedOne(asQuery(text)),
    embedBatch: async (texts) => Promise.all(texts.map((t) => embedOne(asDocument(t)))),
  };
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  const fallback = options.fallback;

  const createProvider = async (id: "openai" | "local" | "gemini") => {
    if (id === "local") {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider };
    }
    if (id === "gemini") {
      const { provider, client } = await createGeminiEmbeddingProvider(options);
      return { provider, gemini: client };
    }
    const { provider, client } = await createOpenAiEmbeddingProvider(options);
    return { provider, openAi: client };
  };

  const formatPrimaryError = (err: unknown, provider: "openai" | "local" | "gemini") =>
    provider === "local" ? formatLocalSetupError(err) : formatError(err);

  if (requestedProvider === "auto") {
    const missingKeyErrors: string[] = [];
    let localError: string | null = null;

    if (canAutoSelectLocal(options)) {
      try {
        const local = await createProvider("local");
        return { ...local, requestedProvider };
      } catch (err) {
        localError = formatLocalSetupError(err);
      }
    }

    for (const provider of ["openai", "gemini"] as const) {
      try {
        const result = await createProvider(provider);
        return { ...result, requestedProvider };
      } catch (err) {
        const message = formatPrimaryError(err, provider);
        if (isMissingApiKeyError(err)) {
          missingKeyErrors.push(message);
          continue;
        }
        throw new Error(message);
      }
    }

    const details = [...missingKeyErrors, localError].filter(Boolean) as string[];
    if (details.length > 0) {
      throw new Error(details.join("\n\n"));
    }
    throw new Error("No embeddings provider available.");
  }

  try {
    const primary = await createProvider(requestedProvider);
    return { ...primary, requestedProvider };
  } catch (primaryErr) {
    const reason = formatPrimaryError(primaryErr, requestedProvider);
    if (fallback && fallback !== "none" && fallback !== requestedProvider) {
      try {
        const fallbackResult = await createProvider(fallback);
        return {
          ...fallbackResult,
          requestedProvider,
          fallbackFrom: requestedProvider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        throw new Error(`${reason}\n\nFallback to ${fallback} failed: ${formatError(fallbackErr)}`);
      }
    }
    throw new Error(reason);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return err.message.includes("node-llama-cpp");
  }
  return false;
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatError(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 22 LTS (recommended for installs/updates)",
    missing
      ? "2) Reinstall FRIDAY (this should install node-llama-cpp): npm i -g friday@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    'Or set agents.defaults.memorySearch.provider = "openai" (remote).',
  ]
    .filter(Boolean)
    .join("\n");
}
