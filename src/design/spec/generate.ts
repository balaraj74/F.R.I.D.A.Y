// Design_Spec (DESIGN.md) generator. Pure: SelectionFile in, markdown string out.
import { REF_INDICES, SCREENS, STYLE_DIRECTIONS, type StyleDirection } from "../refs/plan.js";
import { BANNED_PATTERNS } from "./banned-patterns.js";
import type { SelectionEntry, SelectionFile } from "./types.js";

export const DESIGN_SPEC_SECTIONS = [
  "Principles",
  "Banned patterns",
  "Tokens",
  "Component specs",
  "Layout grid",
  "Accessibility",
  "Voice",
] as const;

export const NO_KEEP_OR_MIX_ERROR =
  "Cannot generate DESIGN.md: at least one keep or mix verdict is required in the selection file.";

export class DesignSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSpecError";
  }
}

function isAccepted(entry: SelectionEntry): boolean {
  return entry.verdict === "keep" || entry.verdict === "mix";
}

/** True iff the selection has at least one keep or mix verdict (Requirement 2.1, 2.2). */
export function canGenerateSpec(selection: SelectionFile): boolean {
  return selection.entries.some(isAccepted);
}

/** Stable order (screen, direction, index) so the output does not depend on entry order. */
function orderedAccepted(selection: SelectionFile): SelectionEntry[] {
  const rank = (e: SelectionEntry) =>
    SCREENS.indexOf(e.screen) * 100 +
    STYLE_DIRECTIONS.indexOf(e.direction) * 10 +
    REF_INDICES.indexOf(e.index);
  return selection.entries
    .filter(isAccepted)
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.position - b.position)
    .map(({ entry }) => entry);
}

/**
 * Render one bullet with the note text kept verbatim. Continuation lines are indented so a
 * multi-line note stays inside its bullet and cannot start a new heading or section.
 */
function noteBullet(entry: SelectionEntry): string {
  const label = `**${entry.screen} / ${entry.direction} #${entry.index + 1}** (${entry.verdict})`;
  if (entry.note.length === 0) {
    return `- ${label}: no note.`;
  }
  const note = entry.note.replace(/\r\n|\r|\n/g, "\n    ");
  return `- ${label}: ${note}`;
}

function principles(accepted: SelectionEntry[]): string[] {
  const directions = new Set<StyleDirection>(accepted.map((e) => e.direction));
  const picked = STYLE_DIRECTIONS.filter((d) => directions.has(d));
  return [
    `- Style direction: build from the ${picked.join(", ")} reference direction${picked.length > 1 ? "s" : ""} the owner marked keep or mix.`,
    "- One source of truth: every colour, spacing, type, radius, elevation and motion value comes from `tokens.json`.",
    "- Hierarchy through contrast and spacing first, then colour, then elevation.",
    "- Restraint: each screen has one primary action and at most one emphasised region.",
  ];
}

function bannedPatterns(): string[] {
  return BANNED_PATTERNS.map((p) => `- **${p.name}**: ${p.definition}`);
}

function tokens(): string[] {
  return [
    "- Source: `tokens.json`, with at least one token in each of colour, type, spacing, radius, elevation and motion.",
    "- Generated files `tokens.css` and `tailwind.tokens.js` are the only places token values are written out.",
    "- Components reference tokens by name. Literal colours, arbitrary Tailwind values and radii outside the token scale are lint errors.",
    "- Text and background colour pairs must reach a WCAG 2.1 contrast ratio of at least 4.5:1.",
  ];
}

function componentSpecs(accepted: SelectionEntry[]): string[] {
  return [
    "- Every component renders colour, spacing, typography, radius and shadow from tokens only.",
    "- Interactive components define default, hover, focus-visible, active and disabled states.",
    // One bullet per keep or mix verdict, carrying its note text (Requirement 2.1).
    ...accepted.map(noteBullet),
  ];
}

function layoutGrid(): string[] {
  return [
    "- Spacing comes from the spacing token scale. No off-scale margins or paddings.",
    "- Content aligns to a 12-column grid at the large window size, 8 columns at medium and 4 columns at small.",
    "- Screens covered: home, chat and the jobs board, each checked at small, medium and large window sizes.",
  ];
}

function accessibility(): string[] {
  return [
    "- Text and background pairs meet a contrast ratio of at least 4.5:1.",
    "- Every interactive element is reachable by keyboard and shows a visible focus indicator.",
    "- Icons that carry meaning have a text label or an accessible name.",
    "- Motion respects the reduced-motion preference.",
  ];
}

function voice(): string[] {
  return [
    "- Plain, direct, short sentences. Address the operator as Sir or Boss.",
    "- Interface labels use sentence case and name the action, for example `Approve action`.",
    "- Error messages state what failed and what to do next.",
  ];
}

/**
 * Build DESIGN.md from the selection. Throws DesignSpecError when there is no keep or mix
 * verdict (Requirement 2.2); callers must leave any existing DESIGN.md untouched in that case.
 */
export function generateDesignSpec(selection: SelectionFile): string {
  if (!canGenerateSpec(selection)) {
    throw new DesignSpecError(NO_KEEP_OR_MIX_ERROR);
  }
  const accepted = orderedAccepted(selection);
  const sections: Array<[(typeof DESIGN_SPEC_SECTIONS)[number], string[]]> = [
    ["Principles", principles(accepted)],
    ["Banned patterns", bannedPatterns()],
    ["Tokens", tokens()],
    ["Component specs", componentSpecs(accepted)],
    ["Layout grid", layoutGrid()],
    ["Accessibility", accessibility()],
    ["Voice", voice()],
  ];
  const body = sections.map(([title, lines]) => `## ${title}\n\n${lines.join("\n")}`);
  return `# FRIDAY Design Spec\n\n${body.join("\n\n")}\n`;
}
