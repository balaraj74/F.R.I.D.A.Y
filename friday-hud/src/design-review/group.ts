import {
  SCREENS,
  STYLE_DIRECTIONS,
  type Manifest,
  type ManifestEntry,
  type Screen,
  type StyleDirection,
} from './types';

/**
 * Gallery grouping, first by Screen and then by Style_Direction (Requirement 1.8).
 * Same semantics as `groupForGallery` in `src/design/refs/plan.ts`: `created` and `failed`
 * entries are kept (failed ones render an error placeholder), `pending` entries are dropped,
 * every screen/direction key is always present, and entries are ordered by index.
 */
export function groupForGallery(
  manifest: Manifest,
): Record<Screen, Record<StyleDirection, ManifestEntry[]>> {
  const grouped = {} as Record<Screen, Record<StyleDirection, ManifestEntry[]>>;
  for (const screen of SCREENS) {
    grouped[screen] = { instrument: [], editorial: [], glass: [] };
  }
  for (const entry of manifest.entries) {
    if (entry.status === 'pending') continue;
    grouped[entry.screen][entry.direction].push(entry);
  }
  for (const screen of SCREENS) {
    for (const direction of STYLE_DIRECTIONS) {
      grouped[screen][direction].sort((a, b) => a.index - b.index);
    }
  }
  return grouped;
}
