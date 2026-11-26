// Creative briefs for the three Style_Directions and three Screens.
// Shared by the image_generate prompts (pipeline.ts) and the HTML fallback (html-mockup.ts)
// so both sources describe the same design.

import type { RefIndex, Screen, StyleDirection } from "./plan.js";

export type DirectionBrief = {
  /** One-line mood used in the image prompt. */
  summary: string;
  /** Concrete visual rules used in the image prompt. */
  rules: string;
  /** Colors for the HTML fallback. */
  palette: {
    bg: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
  };
  fontStack: string;
  /** CSS border-radius used for cards and controls in the HTML fallback. */
  radius: string;
};

export const DIRECTION_BRIEFS: Record<StyleDirection, DirectionBrief> = {
  instrument: {
    summary: "precision instrument panel: dense, monochrome, technical",
    rules:
      "near-black background, thin 1px hairline borders, monospace numerals, tight grid, one amber accent used sparingly, small square corners, no gradients, no glow",
    palette: {
      bg: "#0b0c0e",
      surface: "#121417",
      surfaceAlt: "#181b1f",
      border: "#2a2e34",
      text: "#e6e8ea",
      muted: "#8a9099",
      accent: "#f2a93b",
    },
    fontStack: '"JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace',
    radius: "2px",
  },
  editorial: {
    summary: "editorial layout: calm, typographic, generous whitespace",
    rules:
      "warm off-white paper background, large serif headlines with small sans-serif body, strong type hierarchy, asymmetric columns, thin rules instead of boxes, one deep green accent, no shadows, no gradients",
    palette: {
      bg: "#f5f1e8",
      surface: "#fbf9f3",
      surfaceAlt: "#ece6d8",
      border: "#cfc7b2",
      text: "#1d1b17",
      muted: "#6b665a",
      accent: "#1f5a43",
    },
    fontStack: 'Georgia, "Times New Roman", serif',
    radius: "0px",
  },
  glass: {
    summary: "restrained glass: layered translucent panels over a soft dark backdrop",
    rules:
      "deep slate backdrop, a single level of frosted translucent panels (never glass on glass), soft blur, medium rounded corners with varied sizes, one cool cyan accent, no purple-blue gradients, no glow",
    palette: {
      bg: "#0f1720",
      surface: "#17222e",
      surfaceAlt: "#1e2c3a",
      border: "#2e4155",
      text: "#e8eef4",
      muted: "#93a4b5",
      accent: "#4cc3d9",
    },
    fontStack: 'Inter, "Helvetica Neue", Arial, sans-serif',
    radius: "14px",
  },
};

export type ScreenBrief = {
  title: string;
  /** What the screen shows, for the image prompt. */
  description: string;
};

export const SCREEN_BRIEFS: Record<Screen, ScreenBrief> = {
  home: {
    title: "Home",
    description:
      "the FRIDAY assistant home screen: a greeting, status of voice and gateway, today's schedule, recent activity and quick actions",
  },
  chat: {
    title: "Chat",
    description:
      "the chat screen: conversation thread with user and assistant messages, a tool-call card, and a message composer at the bottom",
  },
  jobs_board: {
    title: "Jobs board",
    description:
      "the jobs board: columns for running, waiting for approval and done jobs, each card showing a goal, progress, elapsed time and token cost",
  },
};

/** Index 1 is a deliberately different layout of the same direction, so the two images offer a real choice. */
export const VARIANT_HINT: Record<RefIndex, string> = {
  0: "primary layout: navigation on the left, content in the center",
  1: "alternate layout: top navigation bar, content in a single wide column with a side detail panel",
};
