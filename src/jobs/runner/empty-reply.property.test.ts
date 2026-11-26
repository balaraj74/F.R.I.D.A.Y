import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isEmptyReply } from "./helpers.js";

// Feature: friday-design-orchestrator-harness, Property 25: Empty replies are always treated as failures
// **Validates: Requirements 6.7**

/** Every code point String.prototype.trim() strips (WhiteSpace + LineTerminator). */
const WHITESPACE_CHARS = [
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
  "\u0020",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];

const whitespaceString = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { maxLength: 40 })
  .map((chars) => chars.join(""));

/** A single UTF-16 code unit that trim() would keep. */
const nonWhitespaceChar = fc
  .string({ unit: "binary", minLength: 1, maxLength: 1 })
  .filter((c) => c.trim().length > 0);

const anyString = fc.string({ unit: "binary", maxLength: 40 });

describe("Feature: friday-design-orchestrator-harness, Property 25: Empty replies are always treated as failures", () => {
  it("returns true for the empty string and any whitespace-only string", () => {
    expect(isEmptyReply("")).toBe(true);
    fc.assert(
      fc.property(whitespaceString, (text) => {
        expect(isEmptyReply(text)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("returns false for any string containing at least one non-whitespace character", () => {
    fc.assert(
      fc.property(whitespaceString, nonWhitespaceChar, anyString, (lead, ch, rest) => {
        expect(isEmptyReply(lead + ch + rest)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
