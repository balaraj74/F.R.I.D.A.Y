// Visual_Regression_Harness configuration (Requirements 3.8-3.11).
//
// Screens and Window_Sizes live here, apart from the harness logic, so later tasks
// (17.5: the Jobs_Views screens) add entries without touching the harness.
import { fileURLToPath } from "node:url";

export type WindowSize = {
  /** Used in file names, so it must match SAFE_NAME. */
  name: string;
  width: number;
  height: number;
};

export type ScreenConfig = {
  /** Used in file names, so it must match SAFE_NAME. */
  name: string;
  /**
   * Path (and query) appended to the base URL. The HUD keeps its active tab in React state
   * and has no router, so every screen is addressed as `/?screen=<name>`. The HUD rebuild
   * must honour that parameter for a screen to render something other than the home tab.
   */
  path: string;
  /** Optional selector that must be visible before the screenshot is taken. */
  waitForSelector?: string;
};

/** The three Window_Sizes (Requirement 3.8). */
export const WINDOW_SIZES: readonly WindowSize[] = [
  { name: "small", width: 480, height: 720 },
  { name: "medium", width: 900, height: 700 },
  { name: "large", width: 1440, height: 900 },
];

/** The three Screens of Requirement 3.8. Task 17.5 appends the Jobs_Views screens here. */
export const BASE_SCREENS: readonly ScreenConfig[] = [
  { name: "home", path: "/?screen=home" },
  { name: "chat", path: "/?screen=chat" },
  { name: "jobs_board", path: "/?screen=jobs_board" },
];

/** Extra screens added by later tasks (for example the Jobs_Views of task 17.5). */
export const EXTRA_SCREENS: readonly ScreenConfig[] = [];

export const SCREENS: readonly ScreenConfig[] = [...BASE_SCREENS, ...EXTRA_SCREENS];

/** URL of the running HUD (`pnpm --dir friday-hud dev` or `preview`). */
export const DEFAULT_BASE_URL = "http://localhost:18790";

/**
 * Differing pixels forgiven as anti-aliasing noise (Requirement 3.9). 0 means any differing
 * pixel fails.
 */
export const DEFAULT_AA_TOLERANCE_PIXELS = 0;

/** A pixel differs when any RGBA channel differs by more than this (0-255). */
export const DEFAULT_CHANNEL_THRESHOLD = 0;

/** Pause after load, so late layout settles before the screenshot. */
export const DEFAULT_SETTLE_MS = 300;

export const DEFAULT_BASELINE_DIR = fileURLToPath(new URL("./baselines", import.meta.url));
export const DEFAULT_DIFF_DIR = fileURLToPath(new URL("./diffs", import.meta.url));

/** Names go into file paths, so they are restricted to a safe subset. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Throws when names are unsafe or duplicated. Returns the inputs for chaining. */
export function validateConfig(
  screens: readonly ScreenConfig[],
  sizes: readonly WindowSize[],
): void {
  const check = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const name of names) {
      if (!SAFE_NAME.test(name)) {
        throw new Error(`Invalid ${kind} name "${name}": use lowercase letters, digits, _ and -`);
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate ${kind} name "${name}"`);
      }
      seen.add(name);
    }
  };
  check(
    "screen",
    screens.map((s) => s.name),
  );
  check(
    "window size",
    sizes.map((s) => s.name),
  );
  if (screens.length === 0 || sizes.length === 0) {
    throw new Error("At least one screen and one window size are required");
  }
}
