import { describe, expect, it } from "vitest";

import { cleanAck, cleanSpoken } from "./fast-brain.js";

describe("cleanAck", () => {
  it("keeps a short acknowledgement", () => {
    expect(cleanAck('"Checking tomorrow\'s calendar, Sir."')).toBe(
      "Checking tomorrow's calendar, Sir.",
    );
  });
  it("treats SKIP and empty as silence", () => {
    expect(cleanAck("SKIP")).toBe("");
    expect(cleanAck("skip.")).toBe("");
    expect(cleanAck("   ")).toBe("");
  });
  it("keeps only the first sentence and strips markdown", () => {
    expect(cleanAck("**On it.** Here is what I found: lots.")).toBe("On it.");
  });
  it("drops rambling or anything naming a model or vendor", () => {
    expect(cleanAck("word ".repeat(20))).toBe("");
    expect(cleanAck("As a Gemini model I will check that.")).toBe("");
  });
});

describe("cleanSpoken", () => {
  it("keeps voice tags whole and drops markdown and stray brackets", () => {
    expect(cleanSpoken("**Done**, Sir. <breath> Ready > next?")).toBe(
      "Done, Sir. <breath> Ready next?",
    );
    expect(cleanSpoken("a <b> c <laugh>")).toBe("a b c <laugh>");
  });
});
