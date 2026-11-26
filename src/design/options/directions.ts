// The directions offered when Sir asks FRIDAY to build something with a UI.
// Three reuse the reference-image briefs; the fourth is a bolder, friendlier option so the
// set is a real spread of looks rather than three variations of one idea.
import { DIRECTION_BRIEFS, type DirectionBrief } from "../refs/directions.js";

export type OptionDirectionId = "instrument" | "editorial" | "glass" | "bold";

export type OptionDirection = DirectionBrief & { id: OptionDirectionId; label: string };

const BOLD: OptionDirection = {
  id: "bold",
  label: "Bold",
  summary: "bold and friendly: large type, flat colour blocks, confident and a little playful",
  rules:
    "warm off-white background, very large geometric sans-serif headlines, flat solid colour blocks, one coral-red accent, generous rounded corners of different sizes, chunky buttons, no gradients, no glow, no shadows",
  palette: {
    bg: "#fff8ee",
    surface: "#ffffff",
    surfaceAlt: "#ffe9cf",
    border: "#1b1a22",
    text: "#17141f",
    muted: "#5d5868",
    accent: "#d6362f",
  },
  fontStack: "Poppins, Helvetica Neue, Arial, sans-serif",
  radius: "20px",
};

const LABELS: Record<Exclude<OptionDirectionId, "bold">, string> = {
  instrument: "Instrument",
  editorial: "Editorial",
  glass: "Glass",
};

/** All directions in the order they are offered. */
export const OPTION_DIRECTIONS: readonly OptionDirection[] = [
  ...(["instrument", "editorial", "glass"] as const).map((id) => ({
    id,
    label: LABELS[id],
    ...DIRECTION_BRIEFS[id],
  })),
  BOLD,
];

export const MIN_OPTIONS = 3;
export const MAX_OPTIONS = 4;

/** Picks `count` directions (3 or 4); out-of-range or fractional counts fall back to 4. */
export function pickDirections(count: number | undefined): OptionDirection[] {
  const n = Number.isInteger(count) && count! >= MIN_OPTIONS && count! <= MAX_OPTIONS ? count! : MAX_OPTIONS;
  return OPTION_DIRECTIONS.slice(0, n);
}

export function buildOptionPrompt(brief: string, direction: OptionDirection): string {
  return (
    `UI design reference mockup, a single full-screen screenshot of the main screen for: ${brief.trim()}. ` +
    `Style: ${direction.summary}. Visual rules: ${direction.rules}. ` +
    "Show realistic, specific placeholder content that fits the product (no lorem ipsum), clear hierarchy, " +
    "real navigation and one primary action. Flat screen capture of the interface only, no device frame, no people."
  );
}
