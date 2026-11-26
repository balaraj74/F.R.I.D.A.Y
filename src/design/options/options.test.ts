import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChoice } from "../../agents/tools/design-tools.js";
import { recordChoice } from "./choose.js";
import { OPTION_DIRECTIONS } from "./directions.js";
import { generateDesignOptions, type GenerateOptionsDeps } from "./generate.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "design-options-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(overrides: Partial<GenerateOptionsDeps> = {}): GenerateOptionsDeps {
  let n = 0;
  return {
    generateImage: async () => {
      const f = path.join(root, `gen-${++n}.png`);
      fs.writeFileSync(f, "png");
      return { path: f };
    },
    captureHtml: async (req) => {
      fs.writeFileSync(req.outputPath, "mock");
      return { path: req.outputPath };
    },
    sleep: async () => undefined,
    mediaDir: path.join(root, "media"),
    ...overrides,
  };
}

describe("generateDesignOptions", () => {
  it("makes four options by default and writes options.json", async () => {
    const project = path.join(root, "app");
    const res = await generateDesignOptions({ brief: "a habit tracker", projectDir: project }, deps());
    expect(res.options.map((o) => o.id)).toEqual([1, 2, 3, 4]);
    expect(res.options.every((o) => o.source === "image_generate")).toBe(true);
    expect(fs.existsSync(path.join(project, "design", "options.json"))).toBe(true);
  });
  it("offers three when asked for three", async () => {
    const res = await generateDesignOptions({ brief: "x", count: 3, projectDir: path.join(root, "a") }, deps());
    expect(res.options).toHaveLength(3);
  });
  it("skips retries on quota errors and uses the HTML mockup", async () => {
    let calls = 0;
    const res = await generateDesignOptions(
      { brief: "a blog", count: 3, projectDir: path.join(root, "b") },
      deps({
        generateImage: async () => {
          calls++;
          throw new Error("RESOURCE_EXHAUSTED: quota");
        },
      }),
    );
    expect(calls).toBe(3);
    expect(res.options.every((o) => o.source === "html_fallback")).toBe(true);
  });
  it("retries ordinary failures before falling back", async () => {
    let calls = 0;
    const res = await generateDesignOptions(
      { brief: "a blog", count: 3, projectDir: path.join(root, "c") },
      deps({
        generateImage: async () => {
          calls++;
          throw new Error("declined");
        },
      }),
    );
    expect(calls).toBe(9);
    expect(res.options).toHaveLength(3);
  });
  it("reports options whose mockup also failed", async () => {
    const res = await generateDesignOptions(
      { brief: "x", count: 3, projectDir: path.join(root, "d") },
      deps({
        generateImage: async () => {
          throw new Error("RESOURCE_EXHAUSTED");
        },
        captureHtml: async () => {
          throw new Error("no browser");
        },
      }),
    );
    expect(res.options).toHaveLength(0);
    expect(res.failed).toHaveLength(3);
  });
});

describe("recordChoice", () => {
  it("writes reference, valid tokens, DESIGN.md and choice.json for every direction", async () => {
    for (const [i, dir] of OPTION_DIRECTIONS.entries()) {
      const project = path.join(root, `p-${dir.id}`);
      await generateDesignOptions({ brief: "a notes app", projectDir: project }, deps());
      const res = await recordChoice({ projectDir: project, ids: [i + 1], note: "less dense" });
      const d = path.join(project, "design");
      expect(fs.existsSync(res.referencePath)).toBe(true);
      expect(fs.existsSync(path.join(d, "tokens.css"))).toBe(true);
      expect(fs.existsSync(path.join(d, "tailwind.tokens.js"))).toBe(true);
      const md = fs.readFileSync(path.join(d, "DESIGN.md"), "utf8");
      expect(md).toContain("## Banned patterns");
      expect(md).toContain("less dense");
    }
  });
  it("rejects an option that does not exist and writes nothing", async () => {
    const project = path.join(root, "e");
    await generateDesignOptions({ brief: "x", count: 3, projectDir: project }, deps());
    await expect(recordChoice({ projectDir: project, ids: [4] })).rejects.toThrow(/does not exist/);
    expect(fs.existsSync(path.join(project, "design", "DESIGN.md"))).toBe(false);
  });
  it("tells Sir to run design_references first when no options exist", async () => {
    await expect(recordChoice({ projectDir: path.join(root, "none"), ids: [1] })).rejects.toThrow(
      /design_references/,
    );
  });
});

describe("parseChoice", () => {
  it("reads one or several numbers from free text", () => {
    expect(parseChoice("2")).toEqual([2]);
    expect(parseChoice("mix 1 and 3")).toEqual([1, 3]);
    expect(parseChoice("I pick option 4 (Bold)")).toEqual([4]);
  });
});
