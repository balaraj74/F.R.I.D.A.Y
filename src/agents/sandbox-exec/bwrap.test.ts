import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSandboxed, sandboxAvailable } from "./bwrap.js";

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe.skipIf(!sandboxAvailable())("bubblewrap sandbox", () => {
  it("runs python, keeps files it writes, and hides the real home", async () => {
    const home = os.homedir();
    const r = await runSandboxed({
      stateDir,
      language: "python",
      code: `import os\nopen("out.txt","w").write("42")\nprint(sum(range(10)), os.path.exists(${JSON.stringify(home)}), os.getcwd())`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("45 False /work");
    expect(r.files).toEqual(["out.txt"]);
    expect(fs.readFileSync(path.join(r.workdir, "out.txt"), "utf-8")).toBe("42");
  });

  it("cannot write outside its scratch folder", async () => {
    const target = path.join(stateDir, "should-not-exist.txt");
    const r = await runSandboxed({
      stateDir,
      language: "bash",
      code: `echo hi > ${target}; echo rc=$?`,
    });
    expect(r.stdout).toContain("rc=1");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("blocks the network unless asked", async () => {
    const code = `import socket\ntry:\n  socket.create_connection(("1.1.1.1", 53), 3); print("online")\nexcept OSError: print("offline")`;
    expect((await runSandboxed({ stateDir, language: "python", code })).stdout.trim()).toBe(
      "offline",
    );
  });

  it("kills runaway code at the time limit", async () => {
    const r = await runSandboxed({
      stateDir,
      language: "node",
      code: "while (true) {}",
      timeoutMs: 1500,
    });
    expect(r.timedOut || r.signal !== null).toBe(true);
    expect(r.durationMs).toBeLessThan(5000);
  });
});
