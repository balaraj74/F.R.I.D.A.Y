import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesignPaths } from "./paths.js";
import { checkDesignSpecExists } from "./ui-guard.js";

describe("checkDesignSpecExists", () => {
  it("allows UI work when DESIGN.md exists", () => {
    const paths = resolveDesignPaths("/work/space");
    expect(checkDesignSpecExists(paths, (p) => p === paths.designSpec)).toEqual({ ok: true });
  });

  it("declines and points to `friday design refs` when DESIGN.md is missing", () => {
    const paths = resolveDesignPaths("/work/space");
    const result = checkDesignSpecExists(paths, () => false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("friday design refs");
      expect(result.message).toContain("no UI files were changed");
      expect(result.message).toContain(paths.designSpec);
    }
  });

  it("checks the real filesystem by default", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ui-guard-"));
    try {
      const paths = resolveDesignPaths(tmp);
      expect(checkDesignSpecExists(paths).ok).toBe(false);
      fs.mkdirSync(paths.dir, { recursive: true });
      fs.writeFileSync(paths.designSpec, "# spec\n");
      expect(checkDesignSpecExists(paths).ok).toBe(true);
    } finally {
      // Test-owned temp dir only.
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
