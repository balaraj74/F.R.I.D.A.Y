// Fixed banned-patterns list for DESIGN.md (Requirement 2.4).
// Each pattern has exactly one observable definition: something a reviewer can check by
// inspecting the rendered UI or its styles. They pair with the Design_Linter rules (Req 3.2).

export type BannedPattern = {
  id: string;
  name: string;
  /** One sentence describing how to detect the pattern. */
  definition: string;
};

export const BANNED_PATTERNS: readonly BannedPattern[] = [
  {
    id: "purple-blue-gradient",
    name: "Purple-blue gradients",
    definition:
      "Any linear-gradient, radial-gradient or conic-gradient in the styles that blends a purple hue with a blue hue.",
  },
  {
    id: "glow-everywhere",
    name: "Glow on every element",
    definition:
      "A box-shadow with a non-zero blur radius and a colour other than an elevation token is applied to more than one element type on a single screen.",
  },
  {
    id: "glass-on-glass",
    name: "Glass on glass",
    definition:
      "An element with a backdrop-filter blur is rendered inside an ancestor that also has a backdrop-filter blur.",
  },
  {
    id: "emoji-icons",
    name: "Emoji as icons",
    definition:
      "An emoji character appears in a button, tab, navigation item or status indicator in place of an icon component.",
  },
  {
    id: "uniform-rounded-cards",
    name: "Uniform rounded cards",
    definition:
      "Every card, panel and button on a screen uses the same border-radius token regardless of its size or nesting level.",
  },
  {
    id: "gradient-text",
    name: "Gradient text",
    definition:
      "Text is filled with a gradient, detected as background-clip: text combined with a gradient background or a transparent text colour.",
  },
  {
    id: "single-accent-everywhere",
    name: "A single accent colour used for everything",
    definition:
      "One accent colour token supplies the background or text colour of primary actions, links, status indicators, borders and highlights on the same screen.",
  },
];
