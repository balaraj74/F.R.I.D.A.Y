// Real implementations of the pipeline's injected dependencies (see pipeline.ts).
// Kept apart from pipeline.ts so tests of the pipeline logic never import Playwright or touch disk.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
} from "../../browser/chrome.executables.js";
import { emptyManifest, type CaptureHtmlFn, type GenerateImageFn } from "./pipeline.js";
import {
  REF_INDICES,
  SCREENS,
  STYLE_DIRECTIONS,
  type Manifest,
  type ManifestEntry,
} from "./plan.js";

/** The slice of the `image_generate` tool the adapter needs. */
export type ImageGenerateToolLike = {
  execute: (toolCallId: string, params: { prompt: string }) => Promise<{ details?: unknown }>;
};

/**
 * Wraps the existing `image_generate` tool (its name and call shape are unchanged).
 * The tool saves into the FRIDAY workspace; this copies the result next to the other
 * references, keeping the real image extension (the tool may return jpg/webp).
 */
export function createImageGenerateAdapter(tool: ImageGenerateToolLike): GenerateImageFn {
  return async (req) => {
    const result = await tool.execute(`design-refs-${randomUUID()}`, { prompt: req.prompt });
    const source = (result.details as { path?: unknown } | undefined)?.path;
    if (typeof source !== "string" || source === "") {
      throw new Error("image_generate returned no saved file path");
    }
    const ext = path.extname(source) || path.extname(req.outputPath);
    const target = path.join(
      path.dirname(req.outputPath),
      `${path.basename(req.outputPath, path.extname(req.outputPath))}${ext}`,
    );
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(source, target);
    return { path: target };
  };
}

function findSystemChrome(): string | undefined {
  const found =
    process.platform === "darwin"
      ? findChromeExecutableMac()
      : process.platform === "win32"
        ? findChromeExecutableWindows()
        : findChromeExecutableLinux();
  return found?.path;
}

export type PlaywrightCapture = {
  captureHtml: CaptureHtmlFn;
  /** Closes the browser if one was started. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * Captures HTML with Playwright (`playwright-core`, the dependency the browser tool already uses).
 * The browser starts on the first capture and is reused for the rest of the run.
 * Uses `executablePath`, else a system Chrome/Chromium if found, else Playwright's own browser.
 */
export function createPlaywrightCapture(
  options: { executablePath?: string } = {},
): PlaywrightCapture {
  type Browser = import("playwright-core").Browser;
  let browser: Browser | undefined;

  const getBrowser = async (): Promise<Browser> => {
    if (!browser) {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({
        headless: true,
        executablePath: options.executablePath ?? findSystemChrome(),
      });
    }
    return browser;
  };

  return {
    captureHtml: async (req) => {
      const instance = await getBrowser();
      const page = await instance.newPage({ viewport: req.viewport });
      try {
        // Scripts are not needed for the static mockup, and the page has no network dependencies.
        await page.setContent(req.html, { waitUntil: "load" });
        await fs.promises.mkdir(path.dirname(req.outputPath), { recursive: true });
        await page.screenshot({ path: req.outputPath, type: "png" });
      } finally {
        await page.close().catch(() => undefined);
      }
      return { path: req.outputPath };
    },
    close: async () => {
      const current = browser;
      browser = undefined;
      await current?.close().catch(() => undefined);
    },
  };
}

/** Atomic manifest writer (temp file + rename), same approach as `writeSelection`. */
export function createManifestWriter(manifestPath: string): (manifest: Manifest) => Promise<void> {
  return async (manifest) => {
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    const tmp = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fs.promises.rename(tmp, manifestPath);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => undefined);
      throw err;
    }
  };
}

const STATUSES = ["pending", "created", "failed"];
const SOURCES = ["image_generate", "html_fallback"];

/** Thrown by `readManifest` for an unreadable or invalid manifest; the file is never modified. */
export class ManifestParseError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Malformed manifest ${path}: ${reason}`);
    this.name = "ManifestParseError";
  }
}

/** Reads `manifest.json`. A missing file yields an empty manifest; a malformed one throws. */
export function readManifest(manifestPath: string): Manifest {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyManifest();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManifestParseError(
      manifestPath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const m = parsed as { version?: unknown; entries?: unknown } | null;
  if (!m || m.version !== 1 || !Array.isArray(m.entries)) {
    throw new ManifestParseError(manifestPath, "expected { version: 1, entries: [] }");
  }
  for (const [i, e] of (m.entries as Array<Partial<ManifestEntry> | null>).entries()) {
    const ok =
      e &&
      (SCREENS as readonly unknown[]).includes(e.screen) &&
      (STYLE_DIRECTIONS as readonly unknown[]).includes(e.direction) &&
      (REF_INDICES as readonly unknown[]).includes(e.index) &&
      STATUSES.includes(e.status as string) &&
      (e.source === undefined || SOURCES.includes(e.source));
    if (!ok) {
      throw new ManifestParseError(manifestPath, `entries[${i}] is not a valid manifest entry`);
    }
  }
  return parsed as Manifest;
}
