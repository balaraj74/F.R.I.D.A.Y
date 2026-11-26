import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTokens } from "./build.js";
import { checkContrast, contrastRatio } from "./contrast.js";
import { generateOutputs } from "./generate.js";
import type { TokenFile } from "./types.js";
import { validateTokenFile } from "./validate.js";

function validTokens(): TokenFile {
  return {
    version: 1,
    color: { ink: "#111111", paper: "#ffffff", mid: "#777777" },
    type: { body: { size: "16px", weight: 400 }, display: "Inter, sans-serif" },
    spacing: { "2": "8px", "10": "40px" },
    radius: { sm: "4px" },
    elevation: { raised: "0 1px 2px #0003" },
    motion: { fast: "120ms" },
    contrastPairs: [{ text: "ink", background: "paper" }],
  };
}

describe("validateTokenFile", () => {
  it("accepts a valid file", () => {
    expect(validateTokenFile(validTokens()).ok).toBe(true);
  });

  it("reports a missing category and an empty category", () => {
    const input: Record<string, unknown> = { ...validTokens(), radius: {} };
    delete input.motion;
    const result = validateTokenFile(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain("/radius");
      expect(paths).toContain("/motion");
    }
  });

  it("reports each invalid token path with a reason", () => {
    const tf = validTokens();
    tf.color.bad = "red";
    tf.spacing["Bad_Key"] = "1px";
    tf.radius.sm = "4px; color: red";
    const result = validateTokenFile(tf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toEqual(
        expect.arrayContaining(["/color/bad", "/spacing/Bad_Key", "/radius/sm"]),
      );
      expect(result.errors.every((e) => e.reason.length > 0)).toBe(true);
    }
  });

  it("rejects low-contrast pairs and reports the ratio to 2dp", () => {
    const tf = validTokens();
    tf.contrastPairs = [{ text: "mid", background: "paper" }];
    const result = validateTokenFile(tf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("/contrastPairs/0");
      expect(result.errors[0]?.reason).toContain("4.48:1");
    }
  });

  it("rejects pairs that name an unknown colour token", () => {
    const tf = validTokens();
    tf.contrastPairs = [{ text: "nope", background: "paper" }];
    const result = validateTokenFile(tf);
    expect(!result.ok && result.errors[0]?.path).toBe("/contrastPairs/0/text");
  });

  it("rejects CSS variable name collisions from nested type tokens", () => {
    const tf = validTokens();
    tf.type["body-size"] = "18px";
    expect(validateTokenFile(tf).ok).toBe(false);
  });
});

describe("checkContrast", () => {
  it("computes the WCAG extremes", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
  });

  it("flags a pair just under 4.5 even when the rounded value is 4.50", () => {
    // #777 on white is 4.4781; the rounded display value is 4.48.
    const failures = checkContrast({
      ...validTokens(),
      contrastPairs: [{ text: "mid", background: "paper" }],
    });
    expect(failures).toEqual([{ fg: "mid", bg: "paper", ratio: 4.48 }]);
  });

  it("returns nothing for passing pairs", () => {
    expect(checkContrast(validTokens())).toEqual([]);
  });
});

describe("generateOutputs", () => {
  it("includes every token and is byte-identical across runs and key orders", () => {
    const a = generateOutputs(validTokens());
    const reordered = validTokens();
    reordered.color = { paper: "#ffffff", mid: "#777777", ink: "#111111" };
    const b = generateOutputs(reordered);
    expect(b).toEqual(a);
    expect(generateOutputs(validTokens())).toEqual(a);

    for (const name of [
      "--color-ink: #111111;",
      "--type-body-size: 16px;",
      "--type-body-weight: 400;",
      "--type-display: Inter, sans-serif;",
      "--spacing-10: 40px;",
      "--radius-sm: 4px;",
      "--elevation-raised: 0 1px 2px #0003;",
      "--motion-fast: 120ms;",
    ]) {
      expect(a.css).toContain(name);
    }
    expect(a.tailwind).toContain('"ink": "#111111"');
    expect(a.tailwind).toContain('"raised": "0 1px 2px #0003"');
    expect(a.tailwind).toContain('"weight": 400');
  });
});

describe("buildTokens", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tokens-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const opts = () => ({
    tokenFilePath: path.join(dir, "tokens.json"),
    cssPath: path.join(dir, "out", "tokens.css"),
    tailwindPath: path.join(dir, "out", "tailwind.tokens.js"),
  });

  it("writes both files for a valid token file", async () => {
    await fs.writeFile(opts().tokenFilePath, JSON.stringify(validTokens()));
    const result = await buildTokens({ ...opts(), writeError: () => {} });
    expect(result.exitCode).toBe(0);
    const css = await fs.readFile(opts().cssPath, "utf8");
    expect(css).toContain("--color-ink: #111111;");
    await fs.access(opts().tailwindPath);
  });

  it("exits non-zero and leaves existing outputs untouched when invalid", async () => {
    await fs.mkdir(path.join(dir, "out"));
    await fs.writeFile(opts().cssPath, "OLD CSS");
    await fs.writeFile(opts().tailwindPath, "OLD TW");
    const bad = validTokens();
    bad.contrastPairs = [{ text: "mid", background: "paper" }];
    await fs.writeFile(opts().tokenFilePath, JSON.stringify(bad));

    const lines: string[] = [];
    const result = await buildTokens({ ...opts(), writeError: (l) => lines.push(l) });
    expect(result.exitCode).not.toBe(0);
    expect(lines.join("\n")).toContain("/contrastPairs/0");
    expect(await fs.readFile(opts().cssPath, "utf8")).toBe("OLD CSS");
    expect(await fs.readFile(opts().tailwindPath, "utf8")).toBe("OLD TW");
  });

  it("writes nothing when the token file is missing or not JSON", async () => {
    const missing = await buildTokens({ ...opts(), writeError: () => {} });
    expect(missing.exitCode).toBe(2);
    await fs.writeFile(opts().tokenFilePath, "{nope");
    const garbled = await buildTokens({ ...opts(), writeError: () => {} });
    expect(garbled.exitCode).toBe(1);
    await expect(fs.access(opts().cssPath)).rejects.toThrow();
  });
});
