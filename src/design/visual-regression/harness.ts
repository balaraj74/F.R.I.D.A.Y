// Visual_Regression_Harness core (Requirements 3.8-3.11).
//
// Everything with side effects (browser capture, pixel diff, file I/O) is injected through
// `HarnessDeps`, so tests drive the harness with fakes. Real implementations live in
// defaults.ts. The pass/fail decision itself is `decideScreenshotResult` (decide.ts).
import path from "node:path";
import {
  SCREENS,
  validateConfig,
  WINDOW_SIZES,
  type ScreenConfig,
  type WindowSize,
} from "./config.js";
import { decideScreenshotResult } from "./decide.js";

export type CaptureRequest = {
  screen: ScreenConfig;
  size: WindowSize;
  /** Base URL joined with the screen path. */
  url: string;
};

/** Resolves with PNG bytes; rejects when the page cannot be captured. */
export type CaptureFn = (req: CaptureRequest) => Promise<Buffer>;

export type PixelDiffResult = {
  /** Number of pixels that differ (images of different sizes count the uncovered area as differing). */
  diffPixels: number;
  /** PNG highlighting the differences. Present when `diffPixels > 0`. */
  diffImage?: Buffer;
};

export type PixelDiffFn = (
  baseline: Buffer,
  actual: Buffer,
  options: { channelThreshold: number },
) => Promise<PixelDiffResult>;

export type HarnessDeps = {
  capture: CaptureFn;
  diff: PixelDiffFn;
  /** Resolves `undefined` when the file does not exist; rejects on any other read error. */
  readFile: (filePath: string) => Promise<Buffer | undefined>;
  /** Creates parent directories as needed. */
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  /** Optional observer. Exceptions it throws are ignored. */
  report?: (event: HarnessResult) => void;
};

export type HarnessOptions = {
  baseUrl: string;
  baselineDir: string;
  diffDir: string;
  /** Overwrite baselines with the new captures (Requirement 3.11). */
  update?: boolean;
  aaTolerancePixels: number;
  channelThreshold: number;
  /** Restrict the run to these screen names. Unknown names are a usage error. */
  only?: readonly string[];
  screens?: readonly ScreenConfig[];
  sizes?: readonly WindowSize[];
};

export type HarnessStatus =
  | "pass"
  | "fail-diff"
  | "fail-missing-baseline"
  | "updated"
  /** The capture, a file read or a file write failed. */
  | "error";

export type HarnessResult = {
  screen: string;
  size: string;
  status: HarnessStatus;
  diffPixels?: number;
  baselinePath: string;
  /** Written for `fail-diff` only. */
  diffPath?: string;
  message?: string;
};

export type HarnessReport = {
  /** 0: all passed (or all baselines updated); 1: a failure; 2: invalid usage or config. */
  exitCode: 0 | 1 | 2;
  results: HarnessResult[];
  /** Set when exitCode is 2. */
  usageError?: string;
};

export function captureFileName(screen: string, size: string): string {
  return `${screen}-${size}.png`;
}

function joinUrl(baseUrl: string, screenPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${screenPath.replace(/^\/+/, "")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkOne(
  screen: ScreenConfig,
  size: WindowSize,
  options: HarnessOptions,
  deps: HarnessDeps,
): Promise<HarnessResult> {
  const file = captureFileName(screen.name, size.name);
  const baselinePath = path.join(options.baselineDir, file);
  const base = { screen: screen.name, size: size.name, baselinePath };
  try {
    let actual: Buffer;
    try {
      actual = await deps.capture({
        screen,
        size,
        url: joinUrl(options.baseUrl, screen.path),
      });
    } catch (err) {
      return { ...base, status: "error", message: `capture failed: ${errorMessage(err)}` };
    }

    if (options.update) {
      await deps.writeFile(baselinePath, actual);
      return { ...base, status: "updated" };
    }

    const baseline = await deps.readFile(baselinePath);
    // A missing baseline fails without being created (Requirement 3.10).
    if (baseline === undefined) {
      const status = decideScreenshotResult(0, options.aaTolerancePixels, false);
      return { ...base, status, message: "baseline is missing" };
    }

    const { diffPixels, diffImage } = await deps.diff(baseline, actual, {
      channelThreshold: options.channelThreshold,
    });
    const status = decideScreenshotResult(diffPixels, options.aaTolerancePixels, true);
    if (status === "fail-diff") {
      const diffPath = path.join(options.diffDir, file.replace(/\.png$/, ".diff.png"));
      if (diffImage) {
        await deps.writeFile(diffPath, diffImage);
        return { ...base, status, diffPixels, diffPath };
      }
      return { ...base, status, diffPixels, message: "no diff image was produced" };
    }
    return { ...base, status, diffPixels };
  } catch (err) {
    return { ...base, status: "error", message: errorMessage(err) };
  }
}

/** Captures every (Screen, Window_Size) sequentially and compares each to its baseline. */
export async function runVisualRegression(
  options: HarnessOptions,
  deps: HarnessDeps,
): Promise<HarnessReport> {
  const allScreens = options.screens ?? SCREENS;
  const sizes = options.sizes ?? WINDOW_SIZES;
  try {
    validateConfig(allScreens, sizes);
  } catch (err) {
    return { exitCode: 2, results: [], usageError: errorMessage(err) };
  }

  let screens = allScreens;
  if (options.only && options.only.length > 0) {
    const known = new Set(allScreens.map((s) => s.name));
    const unknown = options.only.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return {
        exitCode: 2,
        results: [],
        usageError: `Unknown screen: ${unknown.join(", ")}. Known: ${[...known].join(", ")}`,
      };
    }
    screens = allScreens.filter((s) => options.only?.includes(s.name));
  }

  const results: HarnessResult[] = [];
  for (const screen of screens) {
    for (const size of sizes) {
      const result = await checkOne(screen, size, options, deps);
      results.push(result);
      try {
        deps.report?.(result);
      } catch {
        // Observer failures never affect the run.
      }
    }
  }

  const ok = results.every((r) => r.status === "pass" || r.status === "updated");
  return { exitCode: ok ? 0 : 1, results };
}
