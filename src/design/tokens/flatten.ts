import { TOKEN_CATEGORIES, type TokenCategory, type TokenFile } from "./types.js";

export interface FlatToken {
  category: TokenCategory;
  /** Key path inside the category, e.g. ["body", "size"] for a nested type token. */
  segments: string[];
  /** CSS custom property name without the leading `--`, e.g. `type-body-size`. */
  cssName: string;
  value: string;
}

/** Plain code-unit comparison so ordering never depends on the runtime locale. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => compareKeys(a, b));
}

/**
 * Flattens every token into a list ordered by category (fixed order) then key.
 * Tolerates unvalidated `type` values so validation can use it to detect
 * name collisions before the value rules have run.
 */
export function flattenTokens(tf: TokenFile): FlatToken[] {
  const out: FlatToken[] = [];
  for (const category of TOKEN_CATEGORIES) {
    const entries: FlatToken[] = [];
    for (const [key, value] of sortedEntries(tf[category] as Record<string, unknown>)) {
      if (
        category === "type" &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        for (const [sub, subValue] of sortedEntries(value as Record<string, unknown>)) {
          entries.push({
            category,
            segments: [key, sub],
            cssName: `${category}-${key}-${sub}`,
            value: String(subValue),
          });
        }
      } else {
        entries.push({
          category,
          segments: [key],
          cssName: `${category}-${key}`,
          value: String(value),
        });
      }
    }
    out.push(...entries);
  }
  return out;
}
