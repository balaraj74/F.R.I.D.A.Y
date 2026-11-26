import { describe, expect, it } from "vitest";

import { toneHint } from "./tone.js";

const noon = new Date(2026, 9, 30, 12, 0);

describe("toneHint", () => {
  it("slows down when Sir sounds low", () => {
    expect(toneHint("I'm so tired of this", noon)).toMatch(/acknowledge how he feels/);
  });
  it("shares good news", () => {
    expect(toneHint("it works! finally", noon)).toMatch(/glad with him/);
  });
  it("softens late at night, and low mood wins over the clock", () => {
    expect(toneHint("check the build", new Date(2026, 9, 30, 23, 30))).toMatch(/late/);
    expect(toneHint("I'm stressed", new Date(2026, 9, 30, 23, 30))).toMatch(/acknowledge/);
  });
  it("adds nothing for ordinary daytime requests", () => {
    expect(toneHint("check my disk space", noon)).toBe("");
  });
});
