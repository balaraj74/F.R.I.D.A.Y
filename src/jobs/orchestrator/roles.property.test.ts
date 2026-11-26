import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isToolAllowed, ROLE_TOOL_ALLOWLIST } from "./roles.js";
import { ROLES, type Role } from "./types.js";

// Feature: friday-design-orchestrator-harness, Property 29: Role tool allowlist enforcement
// **Validates: Requirements 7.5**

const roleArb: fc.Arbitrary<Role> = fc.constantFrom(...ROLES);
const allTools = [...new Set(ROLES.flatMap((r) => ROLE_TOOL_ALLOWLIST[r]))];

/** Mix of known tool names (so both outcomes occur often), wildcard-ish strings and arbitrary text. */
const toolArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...allTools),
  fc.constantFrom("*", "?", "read*", "*read", "re*", "exec.*", "**", "", " "),
  fc.string({ maxLength: 12 }),
);

describe("Feature: friday-design-orchestrator-harness, Property 29: Role tool allowlist enforcement", () => {
  it("isToolAllowed(role, tool) is true iff tool is in ROLE_TOOL_ALLOWLIST[role]", () => {
    fc.assert(
      fc.property(roleArb, toolArb, (role, tool) => {
        expect(isToolAllowed(role, tool)).toBe(ROLE_TOOL_ALLOWLIST[role].includes(tool));
      }),
      { numRuns: 200 },
    );
  });

  it("denies tool names outside the role's allowlist", () => {
    fc.assert(
      fc.property(
        roleArb,
        fc.string({ maxLength: 12 }).filter((t) => !allTools.includes(t)),
        (role, tool) => {
          expect(isToolAllowed(role, tool)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("allows every listed tool for its own role", () => {
    fc.assert(
      fc.property(
        roleArb.chain((role) =>
          fc.tuple(fc.constant(role), fc.constantFrom(...ROLE_TOOL_ALLOWLIST[role])),
        ),
        ([role, tool]) => {
          expect(isToolAllowed(role, tool)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does no wildcard or partial matching", () => {
    // No allowlist entry is itself a wildcard pattern.
    for (const role of ROLES) {
      for (const entry of ROLE_TOOL_ALLOWLIST[role]) {
        expect(entry).toMatch(/^[a-z_]+$/);
      }
    }
    fc.assert(
      fc.property(
        roleArb,
        fc.constantFrom(...allTools),
        fc.constantFrom("*", "?", ".*", "_*"),
        fc.string({ minLength: 1, maxLength: 6 }),
        (role, tool, wildcard, extra) => {
          const list = ROLE_TOOL_ALLOWLIST[role];
          // Wildcards, glob-style variants, case changes and prefix/suffix extensions are not exact matches.
          for (const candidate of [
            wildcard,
            `${tool}${wildcard}`,
            `${wildcard}${tool}`,
            tool.toUpperCase(),
            `${tool}${extra}`,
            `${extra}${tool}`,
            tool.slice(0, -1),
          ]) {
            expect(isToolAllowed(role, candidate)).toBe(list.includes(candidate));
          }
          expect(isToolAllowed(role, "*")).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
