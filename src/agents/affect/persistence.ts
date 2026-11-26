/**
 * F.R.I.D.A.Y. Causal Upgrade — Phase 2: Affect State Persistence
 *
 * Persists and reads the computed AffectState vector in the session store (.jsonl).
 */

import { type AffectState, sanitizeAffectState } from "./state.js";

export const AFFECT_CUSTOM_TYPE = "friday.affect";

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

/**
 * Reads the latest AffectState recorded in the session, if available.
 */
export function readLastAffectState(sessionManager: unknown): AffectState | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) return null;

  try {
    const entries = sm.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === "custom" && entry?.customType === AFFECT_CUSTOM_TYPE) {
        if (entry.data && typeof entry.data === "object") {
          return sanitizeAffectState(entry.data as Partial<AffectState>);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Appends the computed AffectState to the session (.jsonl store) as a custom entry.
 */
export function appendAffectStateEntry(sessionManager: unknown, state: AffectState): void {
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) return;

  try {
    sm.appendCustomEntry(AFFECT_CUSTOM_TYPE, state);
  } catch {
    // Non-blocking persistence failure
  }
}
