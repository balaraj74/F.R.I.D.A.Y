import { describe, expect, it } from "vitest";

import { stripExpressionTags } from "./expression-tags.js";

describe("stripExpressionTags", () => {
  it("removes voice directions and keeps the words", () => {
    expect(stripExpressionTags("<sigh> Hey. You did well. <laugh> Go on.")).toBe(
      "Hey. You did well. Go on.",
    );
  });
  it("leaves other angle brackets and line breaks alone", () => {
    expect(stripExpressionTags("a <b> c\n<SIGH>next")).toBe("a <b> c\nnext");
  });
});
