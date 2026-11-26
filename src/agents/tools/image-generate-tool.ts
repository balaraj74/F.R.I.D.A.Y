// Make or edit pictures for Sir. The brain's proxy serves an image model through the same
// messages endpoint; the picture comes back as an image block, is saved in FRIDAY's workspace
// (generated/), and the HUD shows it where she writes the MEDIA:<path> line.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import type { FRIDAYConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

export const IMAGE_GEN_MODEL =
  process.env.FRIDAY_IMAGE_GEN_MODEL?.trim() || "gemini-3.1-flash-image";
const IMAGE_GEN_TIMEOUT_MS = 90_000;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const PROVIDER = "antigravity-proxy";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

type Block = { type?: string; text?: string; source?: { media_type?: string; data?: string } };

/** The first picture in a messages-API reply, plus any words the model said alongside it. */
export function extractImage(
  content: unknown,
): { mime: string; data: string; text: string } | null {
  if (!Array.isArray(content)) return null;
  const blocks = content as Block[];
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join(" ")
    .trim();
  const img = blocks.find((b) => b.type === "image" && b.source?.data);
  if (!img?.source?.data) return null;
  return { mime: img.source.media_type ?? "image/png", data: img.source.data, text };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";

/**
 * Generated images are scratch output, so they go to the OS temp directory and
 * never into the agent workspace. Set FRIDAY_GENERATED_DIR to keep them elsewhere.
 */
export function resolveGeneratedDir(
  _workspaceDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.FRIDAY_GENERATED_DIR?.trim();
  if (override) return path.resolve(override);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return path.join(os.tmpdir(), uid != null ? `friday-${uid}` : "friday", "generated");
}

const Schema = Type.Object({
  prompt: Type.String({
    description:
      "What to draw, in detail: subject, style, colours, mood, any text to appear in the picture.",
  }),
  reference: Type.Optional(
    Type.String({
      description:
        "Optional path of an existing image to edit or restyle (e.g. 'make this logo blue'). Leave out to draw from scratch.",
    }),
  ),
});

export function createImageGenerateTool(options: {
  config?: FRIDAYConfig;
  workspaceDir?: string;
  fetchImpl?: typeof fetch;
}): AnyAgentTool {
  return {
    label: "Image generation",
    name: "image_generate",
    description:
      "Create or edit a picture (logo, illustration, poster, wallpaper, mockup, photo-style image) and save it " +
      "to Sir's computer. Takes up to about a minute. After it succeeds, put the returned MEDIA: line on its own " +
      "line in your reply so he sees the picture, and describe it in a sentence. Use image (not this) to LOOK at " +
      "an existing picture.",
    parameters: Schema,
    execute: async (_toolCallId, params) => {
      const prompt = readStringParam(params, "prompt", { required: true });
      const reference = readStringParam(params, "reference");
      const provider = options.config?.models?.providers?.[PROVIDER] as
        | { baseUrl?: string; apiKey?: string }
        | undefined;
      const baseUrl = (provider?.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");

      const content: unknown[] = [];
      if (reference) {
        const file = path.resolve(reference.replace(/^~(?=$|\/)/, os.homedir()));
        const buf = await fs.readFile(file);
        if (buf.length > MAX_REFERENCE_BYTES)
          throw new Error("That reference image is over 10 MB.");
        const mime = MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()];
        if (!mime) throw new Error("The reference must be a png, jpg, webp or gif image.");
        content.push({
          type: "image",
          source: { type: "base64", media_type: mime, data: buf.toString("base64") },
        });
      }
      content.push({ type: "text", text: `Generate an image: ${prompt}` });

      const res = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": provider?.apiKey ?? "test",
        },
        body: JSON.stringify({
          model: IMAGE_GEN_MODEL,
          max_tokens: 4000,
          messages: [{ role: "user", content }],
        }),
        signal: AbortSignal.timeout(IMAGE_GEN_TIMEOUT_MS),
      }).catch((err) => {
        throw new Error(
          err?.name === "TimeoutError"
            ? "Image generation took longer than 90 seconds; try a simpler picture."
            : `Couldn't reach the image engine: ${String(err?.message ?? err)}`,
        );
      });
      if (!res.ok)
        throw new Error(
          `Image generation failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`,
        );

      const image = extractImage(((await res.json()) as { content?: unknown }).content);
      if (!image)
        throw new Error(
          "The image engine returned no picture (it may have declined that prompt). Try rewording it.",
        );

      const dir = resolveGeneratedDir(options.workspaceDir);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const file = path.join(dir, `${stamp}-${slug(prompt)}.${EXT[image.mime] ?? "png"}`);
      const bytes = Buffer.from(image.data, "base64");
      await fs.writeFile(file, bytes);

      return {
        content: [
          {
            type: "text",
            text: `Picture saved. Put this line on its own in your reply so Sir can see it:\nMEDIA:${file}`,
          },
        ],
        details: { path: file, bytes: bytes.length, mime: image.mime },
      };
    },
  };
}
