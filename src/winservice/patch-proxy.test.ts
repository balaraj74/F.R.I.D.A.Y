import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import {
  findCopies,
  npmCacheDir,
  patchFile,
  patchProxy,
} from "../../scripts/patch-antigravity-proxy.mjs";

describe("patch-antigravity-proxy.mjs", () => {
  it("patches the cap, keeps .orig, and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-"));
    const dir = path.join(root, "_npx", "abc", "node_modules", "antigravity-claude-proxy");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), '{\n  "version": "2.8.7"\n}');
    const file = path.join(dir, "src", "constants.js");
    fs.writeFileSync(file, "a\nexport const GEMINI_MAX_OUTPUT_TOKENS = 16384;\nb\n");
    expect(findCopies(path.join(root, "_npx"), "2.8.7")).toEqual([dir]);
    expect(findCopies(path.join(root, "_npx"), "9.9.9")).toEqual([]);
    expect(patchFile(file, "65536")).toBe("patched");
    expect(fs.readFileSync(file, "utf8")).toBe(
      "a\nexport const GEMINI_MAX_OUTPUT_TOKENS = 65536;\nb\n",
    );
    expect(fs.readFileSync(`${file}.orig`, "utf8")).toContain("16384");
    expect(patchFile(file, "65536")).toBe("patched");
    expect(fs.readFileSync(`${file}.orig`, "utf8")).toContain("16384");
    // end to end through patchProxy with an env-pointed cache
    fs.writeFileSync(file, "export const GEMINI_MAX_OUTPUT_TOKENS = 16384;\n");
    const quiet = { log: () => {}, error: () => {} };
    expect(
      patchProxy({
        version: "2.8.7",
        maxOutput: "32768",
        env: { npm_config_cache: root },
        warmCache: false,
        log: quiet,
      }),
    ).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toContain("= 32768;");
  });

  it("reports an unknown pattern and rejects non-numeric limits", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agp-")), "constants.js");
    fs.writeFileSync(f, "nothing here\n");
    expect(patchFile(f, "65536")).toBe("nomatch");
    expect(patchFile(`${f}.nope`, "1")).toBe("missing");
    expect(() => patchProxy({ maxOutput: "abc", warmCache: false })).toThrow(/must be a number/);
  });

  it("finds the npm cache per platform", () => {
    expect(npmCacheDir({}, "linux", "/home/u")).toBe(path.join("/home/u", ".npm"));
    expect(npmCacheDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\u")).toBe("C:\\L\\npm-cache");
    expect(npmCacheDir({ npm_config_cache: "/c" }, "linux", "/h")).toBe("/c");
  });
});
