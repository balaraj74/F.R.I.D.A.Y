// Makes 3 or 4 reference images for whatever Sir asked FRIDAY to build, so he can pick a look
// before any UI code is written. Sequential, with a short retry; falls back to an HTML mockup.
import fs from "node:fs";
import path from "node:path";
import { buildOptionPrompt, pickDirections, type OptionDirectionId } from "./directions.js";
import { buildOptionMockup, OPTION_VIEWPORT } from "./mockup.js";

export type DesignOption = {
  id: number;
  direction: OptionDirectionId;
  label: string;
  /** Permanent copy inside the project. */
  path: string;
  /** A copy the HUD may display (inside the generated-media folder). */
  mediaPath: string;
  source: "image_generate" | "html_fallback";
};

export type OptionsFile = {
  version: 1;
  brief: string;
  createdAt: string;
  options: DesignOption[];
  failed: Array<{ id: number; direction: OptionDirectionId; reason: string }>;
};

export type GenerateOptionsDeps = {
  generateImage: (prompt: string) => Promise<{ path: string }>;
  captureHtml: (req: {
    html: string;
    outputPath: string;
    viewport: { width: number; height: number };
  }) => Promise<{ path: string }>;
  sleep: (ms: number) => Promise<void>;
  /** Folder the HUD is allowed to read; fallback mockups are captured here. */
  mediaDir: string;
};

const RETRY_DELAYS_MS = [2_000, 4_000];

/** Quota errors last for hours, so waiting is pointless: go straight to the fallback. */
const isQuotaError = (message: string) => /RESOURCE_EXHAUSTED|quota/i.test(message);

export function projectDesignDir(projectDir: string): string {
  return path.join(projectDir, "design");
}

async function tryGenerate(
  deps: GenerateOptionsDeps,
  prompt: string,
): Promise<{ path: string } | { error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await deps.generateImage(prompt);
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
      if (isQuotaError(lastError) || attempt === RETRY_DELAYS_MS.length) break;
      await deps.sleep(RETRY_DELAYS_MS[attempt] as number);
    }
  }
  return { error: lastError };
}

export async function generateDesignOptions(
  params: { brief: string; count?: number; projectDir: string },
  deps: GenerateOptionsDeps,
): Promise<OptionsFile> {
  const brief = params.brief.trim();
  if (!brief) throw new Error("brief is required");
  const designDir = projectDesignDir(params.projectDir);
  const refsDir = path.join(designDir, "refs");
  await fs.promises.mkdir(refsDir, { recursive: true });
  await fs.promises.mkdir(deps.mediaDir, { recursive: true });
  const file: OptionsFile = {
    version: 1,
    brief,
    createdAt: new Date().toISOString(),
    options: [],
    failed: [],
  };
  const directions = pickDirections(params.count);
  for (const [i, direction] of directions.entries()) {
    const id = i + 1;
    let source: DesignOption["source"] = "image_generate";
    let mediaPath: string | undefined;
    const generated = await tryGenerate(deps, buildOptionPrompt(brief, direction));
    if ("path" in generated) {
      mediaPath = generated.path;
    } else {
      source = "html_fallback";
      try {
        const out = path.join(deps.mediaDir, `design-option-${Date.now()}-${id}-${direction.id}.png`);
        await deps.captureHtml({
          html: buildOptionMockup(brief, direction),
          outputPath: out,
          viewport: { ...OPTION_VIEWPORT },
        });
        mediaPath = out;
      } catch (err) {
        file.failed.push({
          id,
          direction: direction.id,
          reason: `${generated.error}; mockup capture failed: ${String((err as Error)?.message ?? err)}`,
        });
        continue;
      }
    }
    const ext = path.extname(mediaPath) || ".png";
    const kept = path.join(refsDir, `option-${id}-${direction.id}${ext}`);
    await fs.promises.copyFile(mediaPath, kept);
    file.options.push({ id, direction: direction.id, label: direction.label, path: kept, mediaPath, source });
  }
  const target = path.join(designDir, "options.json");
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmp, target);
  return file;
}

export async function readOptionsFile(projectDir: string): Promise<OptionsFile> {
  const target = path.join(projectDesignDir(projectDir), "options.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(target, "utf8");
  } catch {
    throw new Error(`No design options found for this project (${target}). Run design_references first.`);
  }
  const parsed = JSON.parse(raw) as OptionsFile;
  if (!parsed || !Array.isArray(parsed.options)) throw new Error(`Malformed options file: ${target}`);
  return parsed;
}
