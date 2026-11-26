// Real implementations of the harness's injected dependencies (see harness.ts).
// Kept apart so tests of the harness logic never import Playwright or touch a browser.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
} from "../../browser/chrome.executables.js";
import { DEFAULT_SETTLE_MS } from "./config.js";
import type { CaptureFn, PixelDiffFn } from "./harness.js";

type Sharp = typeof import("sharp");

async function loadSharp(): Promise<Sharp> {
  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  return mod.default ?? (mod as unknown as Sharp);
}

type RawImage = { data: Buffer; width: number; height: number };

async function decodePng(sharp: Sharp, png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Compares two PNGs pixel by pixel. A pixel differs when any RGBA channel differs by more
 * than `channelThreshold`. Where the images differ in size, the area covered by only one of
 * them counts as differing, so a size change always fails. The diff image has the size of the
 * larger canvas: differing pixels are red, matching pixels are a faded copy of the baseline.
 */
export const comparePngs: PixelDiffFn = async (baseline, actual, { channelThreshold }) => {
  const sharp = await loadSharp();
  const a = await decodePng(sharp, baseline);
  const b = await decodePng(sharp, actual);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = Buffer.alloc(width * height * 4);
  let diffPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      let differs = !(inA && inB);
      if (inA && inB) {
        const ia = (y * a.width + x) * 4;
        const ib = (y * b.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (Math.abs((a.data[ia + c] ?? 0) - (b.data[ib + c] ?? 0)) > channelThreshold) {
            differs = true;
            break;
          }
        }
      }
      if (differs) {
        diffPixels++;
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 255;
      } else {
        const ia = (y * a.width + x) * 4;
        // Fade toward white so differences stand out.
        out[o] = 255 - Math.round((255 - (a.data[ia] ?? 0)) * 0.25);
        out[o + 1] = 255 - Math.round((255 - (a.data[ia + 1] ?? 0)) * 0.25);
        out[o + 2] = 255 - Math.round((255 - (a.data[ia + 2] ?? 0)) * 0.25);
        out[o + 3] = 255;
      }
    }
  }

  if (diffPixels === 0) {
    return { diffPixels };
  }
  const diffImage = await sharp(out, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return { diffPixels, diffImage };
};

function findSystemChrome(): string | undefined {
  const found =
    process.platform === "darwin"
      ? findChromeExecutableMac()
      : process.platform === "win32"
        ? findChromeExecutableWindows()
        : findChromeExecutableLinux();
  return found?.path;
}

export type PlaywrightScreenCapture = {
  capture: CaptureFn;
  /** Closes the browser if one was started. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * Captures a URL with Playwright (`playwright-core`, the dependency the browser tool and the
 * Reference_Pipeline already use). The browser starts on the first capture and is reused.
 * Animations and the text caret are disabled so repeated captures are stable.
 */
export function createPlaywrightScreenCapture(
  options: { executablePath?: string; settleMs?: number } = {},
): PlaywrightScreenCapture {
  type Browser = import("playwright-core").Browser;
  let browser: Browser | undefined;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

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
    capture: async ({ screen, size, url }) => {
      const instance = await getBrowser();
      const page = await instance.newPage({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 1,
      });
      try {
        // "load", not "networkidle": the HUD keeps a gateway connection open.
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        if (screen.waitForSelector) {
          await page.waitForSelector(screen.waitForSelector, { state: "visible", timeout: 15_000 });
        }
        if (settleMs > 0) {
          await page.waitForTimeout(settleMs);
        }
        return await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    close: async () => {
      const current = browser;
      browser = undefined;
      await current?.close().catch(() => undefined);
    },
  };
}

export async function readFileIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Atomic write (temp file + rename) so an interrupted run never leaves a truncated PNG. */
export async function writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
