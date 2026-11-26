import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, requestSessionTitle } from "./session-title.js";

describe("cleanGeneratedTitle", () => {
  it("strips quotes, labels and the trailing period", () => {
    expect(cleanGeneratedTitle('Title: "Fixing the arc reactor colour."')).toBe(
      "Fixing the arc reactor colour",
    );
  });
  it("keeps only the first line and caps the length at a word boundary", () => {
    const long = "word ".repeat(30);
    const out = cleanGeneratedTitle(`${long}\nsecond line`);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).not.toContain("second");
  });
  it("returns an empty string for an empty reply", () => {
    expect(cleanGeneratedTitle("  \n ")).toBe("");
  });
});

describe("requestSessionTitle", () => {
  it("asks the proxy and returns the cleaned title", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: '"Planning a weekend trip"' }] }),
    })) as unknown as typeof fetch;
    const title = await requestSessionTitle({
      cfg: {} as never,
      userText: "plan my trip",
      assistantText: "Sure",
      fetchImpl,
    });
    expect(title).toBe("Planning a weekend trip");
  });
});
