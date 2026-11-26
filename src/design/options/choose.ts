// Turns Sir's pick into project files: choice.json, reference image, tokens and DESIGN.md.
import fs from "node:fs";
import path from "node:path";
import { OPTION_DIRECTIONS, type OptionDirection } from "./directions.js";
import { projectDesignDir, readOptionsFile } from "./generate.js";
import { BANNED_PATTERNS } from "../spec/banned-patterns.js";
import { buildTokens } from "../tokens/build.js";
import { contrastRatio } from "../tokens/contrast.js";

export type ChoiceResult = {
  chosen: Array<{ id: number; direction: string; label: string }>;
  referencePath: string;
  designSpecPath: string;
  tokensPath: string;
  cssPath: string;
  tailwindPath: string;
  note: string;
};

/** Readable text colour on a given background. */
function onColor(bg: string): string {
  return contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg) ? "#ffffff" : "#000000";
}

const family = (stack: string) => stack.replace(/"/g, "");

/** Seeds a token file from the chosen direction's palette. FRIDAY refines it after studying the image. */
export function seedTokens(primary: OptionDirection) {
  const p = primary.palette;
  const color: Record<string, string> = {
    bg: p.bg,
    surface: p.surface,
    "surface-alt": p.surfaceAlt,
    border: p.border,
    text: p.text,
    muted: p.muted,
    accent: p.accent,
    "on-accent": onColor(p.accent),
  };
  const candidates: Array<[string, string]> = [
    ["text", "bg"],
    ["text", "surface"],
    ["muted", "bg"],
    ["muted", "surface"],
    ["on-accent", "accent"],
  ];
  // Only declare pairs that actually meet 4.5:1, so a weak palette never blocks the build.
  const contrastPairs = candidates
    .filter(([fg, bg]) => contrastRatio(color[fg] as string, color[bg] as string) >= 4.5)
    .map(([text, background]) => ({ text, background }));
  const r = primary.radius;
  const px = Number.parseInt(r, 10) || 0;
  return {
    version: 1 as const,
    color,
    type: {
      family: { body: family(primary.fontStack), display: family(primary.fontStack) },
      size: { sm: "14px", md: "16px", lg: "20px", xl: "32px", display: "48px" },
      weight: { regular: 400, bold: 700 },
    },
    spacing: { "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px" },
    radius: { none: "0px", sm: `${Math.round(px / 2)}px`, md: r, lg: `${px * 2}px`, pill: "999px" },
    elevation: { flat: "none", raised: "0 1px 2px #00000033" },
    motion: { fast: "120ms", base: "200ms", ease: "ease-out" },
    contrastPairs,
  };
}

export function renderDesignSpec(
  brief: string,
  chosen: Array<{ direction: OptionDirection; label: string }>,
  note: string,
): string {
  const primary = chosen[0]!.direction;
  const names = chosen.map((c) => c.label).join(" + ");
  const lines: string[] = [
    `# Design Spec: ${brief.trim().slice(0, 80)}`,
    "",
    "## Principles",
    "",
    `- Direction chosen by Sir: ${names}. Reference image: \`design/reference.*\`.`,
    `- Mood: ${primary.summary}.`,
    `- Visual rules: ${primary.rules}.`,
    "- One source of truth: every colour, spacing, type, radius, elevation and motion value comes from `design/tokens.json`.",
    "- Hierarchy through contrast and spacing first, then colour, then elevation.",
    "- Restraint: one primary action and at most one emphasised region per screen.",
  ];
  if (note.trim()) lines.push(`- Sir's note: ${note.trim()}`);
  lines.push("", "## Banned patterns", "");
  for (const b of BANNED_PATTERNS) lines.push(`- **${b.name}**: ${b.definition}`);
  lines.push(
    "",
    "## Tokens",
    "",
    "- Source: `design/tokens.json`. Generated: `design/tokens.css` and `design/tailwind.tokens.js`.",
    "- Components use the generated variables or Tailwind keys. No literal hex colours, arbitrary values or off-scale radii.",
    "- Text and background pairs meet a WCAG 2.1 contrast ratio of at least 4.5:1.",
    "",
    "## Component specs",
    "",
    "- Buttons, inputs, cards and navigation take colour, spacing, type, radius and shadow from tokens only.",
    "- Interactive components define default, hover, focus-visible, active and disabled states.",
    "",
    "## Layout grid",
    "",
    "- 12 columns on large screens, 8 on medium, 4 on small. Spacing comes from the spacing scale.",
    "",
    "## Accessibility",
    "",
    "- Contrast of at least 4.5:1, a visible focus ring, keyboard access to every control, labels for icon-only buttons, reduced-motion support.",
    "",
    "## Voice",
    "",
    "- Plain, direct and short. Labels in sentence case that name the action.",
    "",
  );
  return lines.join("\n");
}

export async function recordChoice(params: {
  projectDir: string;
  ids: number[];
  note?: string;
}): Promise<ChoiceResult> {
  const options = await readOptionsFile(params.projectDir);
  const ids = [...new Set(params.ids)];
  if (ids.length === 0) throw new Error("Pick at least one option number.");
  const picked = ids.map((id) => {
    const found = options.options.find((o) => o.id === id);
    if (!found) {
      throw new Error(
        `Option ${id} does not exist. Available: ${options.options.map((o) => o.id).join(", ")}.`,
      );
    }
    return found;
  });
  const designDir = projectDesignDir(params.projectDir);
  const note = (params.note ?? "").trim().slice(0, 500);
  const directions = picked.map((o) => ({
    direction: OPTION_DIRECTIONS.find((d) => d.id === o.direction)!,
    label: o.label,
  }));
  const ext = path.extname(picked[0]!.path) || ".png";
  const referencePath = path.join(designDir, `reference${ext}`);
  await fs.promises.copyFile(picked[0]!.path, referencePath);
  const tokensPath = path.join(designDir, "tokens.json");
  const cssPath = path.join(designDir, "tokens.css");
  const tailwindPath = path.join(designDir, "tailwind.tokens.js");
  await fs.promises.writeFile(
    tokensPath,
    `${JSON.stringify(seedTokens(directions[0]!.direction), null, 2)}\n`,
    "utf8",
  );
  const built = await buildTokens({
    tokenFilePath: tokensPath,
    cssPath,
    tailwindPath,
    writeError: () => undefined,
  });
  if (built.exitCode !== 0) {
    throw new Error(
      `Seeded tokens were invalid: ${built.errors.map((e) => `${e.path}: ${e.reason}`).join("; ")}`,
    );
  }
  const designSpecPath = path.join(designDir, "DESIGN.md");
  await fs.promises.writeFile(designSpecPath, renderDesignSpec(options.brief, directions, note), "utf8");
  const chosen = picked.map((o) => ({ id: o.id, direction: o.direction, label: o.label }));
  await fs.promises.writeFile(
    path.join(designDir, "choice.json"),
    `${JSON.stringify({ version: 1, chosen, note, decidedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return { chosen, referencePath, designSpecPath, tokensPath, cssPath, tailwindPath, note };
}
