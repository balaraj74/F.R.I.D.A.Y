// Local mirror of the reference-image types in `src/design/refs/plan.ts` and
// `src/design/refs/selection.ts`. The HUD is a separate package (its tsconfig only
// includes `src`), so these are re-declared here instead of imported across packages.
// Keep them in sync with the originals.

export const STYLE_DIRECTIONS = ['instrument', 'editorial', 'glass'] as const;
export const SCREENS = ['home', 'chat', 'jobs_board'] as const;
export const VERDICTS = ['keep', 'reject', 'mix'] as const;

/** Maximum note length, in UTF-16 code units (same measure as `selection.ts`). */
export const NOTE_MAX_LENGTH = 500;

export type StyleDirection = (typeof STYLE_DIRECTIONS)[number];
export type Screen = (typeof SCREENS)[number];
export type RefIndex = 0 | 1;
export type RefStatus = 'pending' | 'created' | 'failed';
export type Verdict = (typeof VERDICTS)[number];

export type ManifestEntry = {
  screen: Screen;
  direction: StyleDirection;
  index: RefIndex;
  status: RefStatus;
  source?: 'image_generate' | 'html_fallback';
  path?: string;
  failureReason?: string;
};

export type Manifest = {
  version: 1;
  entries: ManifestEntry[];
};

export type SelectionEntry = {
  screen: Screen;
  direction: StyleDirection;
  index: RefIndex;
  verdict: Verdict;
  note: string;
};

export type SelectionFile = {
  version: 1;
  entries: SelectionEntry[];
};

/**
 * Injected persistence function. It receives the complete selection and must write it
 * to `selection.json` (for example through a gateway call that wraps `writeSelection`).
 * It should reject when the write fails.
 */
export type PersistSelection = (file: SelectionFile) => Promise<void>;
