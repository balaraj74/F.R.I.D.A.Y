// Pure planning helpers for the design reference-image pipeline.
// No I/O here: generation, Playwright capture and file writes live in pipeline.ts.

export const STYLE_DIRECTIONS = ["instrument", "editorial", "glass"] as const;
export const SCREENS = ["home", "chat", "jobs_board"] as const;
export const REF_INDICES = [0, 1] as const;

export type StyleDirection = (typeof STYLE_DIRECTIONS)[number];
export type Screen = (typeof SCREENS)[number];
export type RefIndex = (typeof REF_INDICES)[number];
export type RefSource = "image_generate" | "html_fallback";
export type RefStatus = "pending" | "created" | "failed";

export type ManifestEntry = {
  screen: Screen;
  direction: StyleDirection;
  /** 2 images per (screen, direction). */
  index: RefIndex;
  status: RefStatus;
  source?: RefSource;
  path?: string;
  failureReason?: string;
};

export type Manifest = {
  version: 1;
  entries: ManifestEntry[];
};

export type RefCombination = {
  screen: Screen;
  direction: StyleDirection;
  index: RefIndex;
};

/** Base delay before the first retry (Requirement 1.3). */
export const BACKOFF_BASE_MS = 2_000;
/** Maximum retries per Reference_Image (Requirement 1.3). */
export const MAX_RETRIES = 5;
/** Minimum wait after RESOURCE_EXHAUSTED (Requirement 1.4). */
export const RESOURCE_EXHAUSTED_MIN_MS = 30_000;

/** All 18 (screen, direction, index) combinations, in a stable order. */
export function planCombinations(): RefCombination[] {
  const combos: RefCombination[] = [];
  for (const screen of SCREENS) {
    for (const direction of STYLE_DIRECTIONS) {
      for (const index of REF_INDICES) {
        combos.push({ screen, direction, index });
      }
    }
  }
  return combos;
}

/**
 * Delay before retry number `attempt` (1-based: the number of failed attempts so far).
 * The delay doubles per failed attempt starting at 2s. Attempt 5 is the last retry,
 * so larger values are clamped to it. After RESOURCE_EXHAUSTED the delay is at least 30s.
 * The attempt counts toward the retry maximum either way.
 */
export function nextBackoffMs(attempt: number, isResourceExhausted: boolean): number {
  const clamped = Math.min(Math.max(Math.trunc(attempt) || 1, 1), MAX_RETRIES);
  const computed = BACKOFF_BASE_MS * 2 ** (clamped - 1);
  return isResourceExhausted ? Math.max(computed, RESOURCE_EXHAUSTED_MIN_MS) : computed;
}

function comboKey(c: RefCombination): string {
  return `${c.screen}/${c.direction}/${c.index}`;
}

/**
 * Entries the pipeline must generate on this run, in plan order.
 * - regenerate: all 18 combinations, regardless of manifest status (Requirement 1.14).
 * - otherwise: combinations missing from the manifest, still pending, or failed.
 *   Entries with status `created` are skipped (Requirement 1.13).
 * Combinations absent from the manifest are returned as fresh `pending` entries.
 */
export function entriesToGenerate(manifest: Manifest, regenerate: boolean): ManifestEntry[] {
  const existing = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    existing.set(comboKey(entry), entry);
  }
  const result: ManifestEntry[] = [];
  for (const combo of planCombinations()) {
    const entry = existing.get(comboKey(combo));
    if (regenerate) {
      result.push({ ...combo, status: "pending" });
    } else if (!entry) {
      result.push({ ...combo, status: "pending" });
    } else if (entry.status !== "created") {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Gallery grouping: first by Screen, then by Style_Direction (Requirement 1.8).
 * Includes `created` and `failed` entries only (failed ones render an error placeholder);
 * `pending` entries have nothing to show. Every screen/direction key is always present.
 */
export function groupForGallery(
  manifest: Manifest,
): Record<Screen, Record<StyleDirection, ManifestEntry[]>> {
  const grouped = {} as Record<Screen, Record<StyleDirection, ManifestEntry[]>>;
  for (const screen of SCREENS) {
    grouped[screen] = { instrument: [], editorial: [], glass: [] };
  }
  for (const entry of manifest.entries) {
    if (entry.status === "pending") {
      continue;
    }
    grouped[entry.screen][entry.direction].push(entry);
  }
  for (const screen of SCREENS) {
    for (const direction of STYLE_DIRECTIONS) {
      grouped[screen][direction].sort((a, b) => a.index - b.index);
    }
  }
  return grouped;
}
