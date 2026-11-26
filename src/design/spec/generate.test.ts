import { describe, expect, it } from "vitest";
import { BANNED_PATTERNS } from "./banned-patterns.js";
import {
  DESIGN_SPEC_SECTIONS,
  DesignSpecError,
  canGenerateSpec,
  generateDesignSpec,
} from "./generate.js";
import type { SelectionFile } from "./types.js";

const selection = (entries: SelectionFile["entries"]): SelectionFile => ({ version: 1, entries });

describe("design spec generator", () => {
  it("requires at least one keep or mix verdict", () => {
    expect(canGenerateSpec(selection([]))).toBe(false);
    expect(
      canGenerateSpec(
        selection([{ screen: "home", direction: "glass", index: 0, verdict: "reject", note: "x" }]),
      ),
    ).toBe(false);
    expect(
      canGenerateSpec(
        selection([{ screen: "home", direction: "glass", index: 0, verdict: "mix", note: "" }]),
      ),
    ).toBe(true);
    expect(() => generateDesignSpec(selection([]))).toThrow(DesignSpecError);
  });

  it("emits the seven sections, each with an entry, and the banned patterns", () => {
    const md = generateDesignSpec(
      selection([
        { screen: "chat", direction: "editorial", index: 1, verdict: "keep", note: "calm serif" },
      ]),
    );
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...DESIGN_SPEC_SECTIONS]);
    for (const part of md.split(/^## /m).slice(1)) {
      expect(part).toMatch(/^- /m);
    }
    for (const p of BANNED_PATTERNS) {
      expect(md).toContain(`**${p.name}**: ${p.definition}`);
    }
    expect(BANNED_PATTERNS).toHaveLength(7);
  });

  it("puts every keep and mix note in the component specs section, and omits rejected notes", () => {
    const md = generateDesignSpec(
      selection([
        { screen: "home", direction: "instrument", index: 0, verdict: "keep", note: "tight grid" },
        { screen: "home", direction: "glass", index: 1, verdict: "mix", note: "soft panel edge" },
        { screen: "chat", direction: "glass", index: 0, verdict: "reject", note: "too glowy" },
      ]),
    );
    const specs = md.split(/^## /m).find((s) => s.startsWith("Component specs")) ?? "";
    expect(specs).toContain("tight grid");
    expect(specs).toContain("soft panel edge");
    expect(md).not.toContain("too glowy");
  });

  it("keeps a multi-line note inside its bullet without creating headings", () => {
    const md = generateDesignSpec(
      selection([
        { screen: "home", direction: "glass", index: 0, verdict: "keep", note: "a\n## Voice\nb" },
      ]),
    );
    expect([...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([...DESIGN_SPEC_SECTIONS]);
  });

  it("is deterministic regardless of entry order", () => {
    const a = { screen: "home", direction: "glass", index: 0, verdict: "keep", note: "a" } as const;
    const b = {
      screen: "chat",
      direction: "instrument",
      index: 1,
      verdict: "mix",
      note: "b",
    } as const;
    expect(generateDesignSpec(selection([a, b]))).toBe(generateDesignSpec(selection([b, a])));
  });
});
