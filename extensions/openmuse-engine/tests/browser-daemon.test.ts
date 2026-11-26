import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BrowserDaemon } from "../src/browser-worker/browser-daemon.js";

describe("OpenMuse Browser Daemon Substrate", () => {
  let tmpDir: string;
  let daemon: BrowserDaemon;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-browser-test-"));
    daemon = new BrowserDaemon(tmpDir);
  });

  afterEach(async () => {
    await daemon.closeAll();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("initializes persistent profile directories correctly", async () => {
    const exists = await fs
      .stat(tmpDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test("detects installed chrome binary on linux environment", () => {
    const exe = (daemon as any).detectExecutablePath();
    expect(exe).toBeDefined();
    expect(typeof exe).toBe("string");
    expect(exe).toContain("chrome");
  });

  test("handles profile close safely when no context is open", async () => {
    await expect(daemon.closeProfile("nonexistent")).resolves.not.toThrow();
    await expect(daemon.closeAll()).resolves.not.toThrow();
  });
});
