// Default on-disk locations for the design track. One module so the reference pipeline,
// the Design_Spec and token commands and the Design_Linter agree on where files live.

import path from "node:path";

/** Directory (relative to the workspace root) that holds all design artifacts. */
export const DESIGN_DIR_NAME = "design";

export const MANIFEST_FILE_NAME = "manifest.json";
export const REFS_DIR_NAME = "refs";
export const SELECTION_FILE_NAME = "selection.json";
export const DESIGN_SPEC_FILE_NAME = "DESIGN.md";
export const TOKENS_FILE_NAME = "tokens.json";
/** Files written by the Token_Generator. The Design_Linter treats them as generated files. */
export const TOKENS_CSS_FILE_NAME = "tokens.css";
export const TAILWIND_TOKENS_FILE_NAME = "tailwind.tokens.js";
/** Push decision for the HUD migration gate (relative to the design directory). */
export const MIGRATION_DECISION_FILE_NAME = "migration-decision.json";
/** Committed Design_Linter baseline (relative to the design directory). */
export const LINT_BASELINE_FILE_NAME = "lint-baseline.json";
/** HUD source root that `pnpm design:lint` scans (relative to the workspace root). */
export const HUD_SRC_DIR = "friday-hud/src";

export type DesignPaths = {
  /** `<workspace>/design` (or the override). */
  dir: string;
  /** Reference_Image manifest. */
  manifest: string;
  /** Directory that receives the Reference_Images. */
  refsDir: string;
  /** Selection_File written by the Design_Review_Gallery. */
  selection: string;
  /** Design_Spec. */
  designSpec: string;
  /** Token_File. */
  tokens: string;
  /** Generated CSS variables file, next to the Token_File. */
  tokensCss: string;
  /** Generated Tailwind config file, next to the Token_File. */
  tailwindTokens: string;
};

/**
 * Resolves every design path from the workspace root. `designDir` overrides the
 * default `<workspaceDir>/design` (relative values resolve against `workspaceDir`).
 */
export function resolveDesignPaths(workspaceDir: string, designDir?: string): DesignPaths {
  const dir = path.resolve(workspaceDir, designDir?.trim() || DESIGN_DIR_NAME);
  return {
    dir,
    manifest: path.join(dir, MANIFEST_FILE_NAME),
    refsDir: path.join(dir, REFS_DIR_NAME),
    selection: path.join(dir, SELECTION_FILE_NAME),
    designSpec: path.join(dir, DESIGN_SPEC_FILE_NAME),
    tokens: path.join(dir, TOKENS_FILE_NAME),
    tokensCss: path.join(dir, TOKENS_CSS_FILE_NAME),
    tailwindTokens: path.join(dir, TAILWIND_TOKENS_FILE_NAME),
  };
}
