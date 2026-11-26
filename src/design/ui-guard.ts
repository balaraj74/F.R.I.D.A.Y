// UI guard: UI work requires an existing Design_Spec (DESIGN.md). Pure apart from the
// injectable existence check, so the agent, a tool hook or a test can call it.

import fs from "node:fs";
import type { DesignPaths } from "./paths.js";

export type UiGuardResult = { ok: true } | { ok: false; message: string };

export const DESIGN_SPEC_MISSING_MESSAGE =
  "Declining the UI change: the Design_Spec (DESIGN.md) does not exist, so no UI files were changed. " +
  "Run `friday design refs` to generate reference images, review them, then run `friday design spec`.";

/**
 * Returns `{ ok: true }` when the Design_Spec file exists, otherwise a message that tells
 * the user to run `friday design refs`. Callers must make no UI file changes on `ok: false`.
 */
export function checkDesignSpecExists(
  paths: Pick<DesignPaths, "designSpec">,
  fileExists: (filePath: string) => boolean = (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
): UiGuardResult {
  if (fileExists(paths.designSpec)) {
    return { ok: true };
  }
  return { ok: false, message: `${DESIGN_SPEC_MISSING_MESSAGE} (expected: ${paths.designSpec})` };
}
