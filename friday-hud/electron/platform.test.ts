import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const p = createRequire(import.meta.url)("./platform.cjs") as typeof import("./platform.cjs");

describe("platform helpers", () => {
  it("venvPython picks the right layout", () => {
    expect(p.venvPython("C:\\Users\\a b\\venv", "win32")).toBe("C:\\Users\\a b\\venv\\Scripts\\python.exe");
    expect(p.venvPython("/home/a/venv", "linux")).toBe("/home/a/venv/bin/python");
    expect(p.venvBin("/v", "edge-tts", "linux")).toBe("/v/bin/edge-tts");
    expect(p.venvBin("C:\\v", "edge-tts", "win32")).toBe("C:\\v\\Scripts\\edge-tts.exe");
  });

  it("keeps /tmp/friday on Linux and uses tmpdir on Windows", () => {
    expect(p.logDir("linux")).toBe("/tmp/friday");
    expect(p.friendlyTmpDir("linux")).toBe("/tmp");
    expect(p.logDir("win32")).toMatch(/friday$/);
  });

  it("parses netstat, ss and lsof output", () => {
    const net = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:18789        0.0.0.0:0              LISTENING       4242",
      "  TCP    127.0.0.1:187890       0.0.0.0:0              LISTENING       1",
      "  TCP    127.0.0.1:18789        127.0.0.1:5000         ESTABLISHED     77",
      "  TCP    [::]:18789             [::]:0                 LISTENING       4242",
    ].join("\r\n");
    expect(p.parseNetstat(net, 18789)).toEqual([4242]);
    expect(p.parseSs('LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=11,fd=3),("node",pid=12,fd=3))')).toEqual([11, 12]);
    expect(p.parseLsof("5\n6\n5\n")).toEqual([5, 6]);
  });

  it("findPidByPort uses netstat on Windows and ss on Linux", async () => {
    const run = vi.fn((cmd: string, _a: string[], _o: unknown, cb: (e: Error | null, out?: string) => void) =>
      cb(null, cmd === "netstat" ? "  TCP 127.0.0.1:8080 0.0.0.0:0 LISTENING 9" : "x pid=3,"),
    );
    expect(await p.findPidByPort(8080, { platform: "win32", run })).toEqual([9]);
    expect(run.mock.calls[0][0]).toBe("netstat");
    expect(await p.findPidByPort(8080, { platform: "linux", run })).toEqual([3]);
    expect(run.mock.calls[1][0]).toBe("ss");
  });

  it("findPidByPort falls back to lsof when ss is missing", async () => {
    const run = vi.fn((cmd: string, _a: string[], _o: unknown, cb: (e: Error | null, out?: string) => void) =>
      cmd === "ss" ? cb(new Error("ENOENT")) : cb(null, "21\n"),
    );
    expect(await p.findPidByPort(1, { platform: "linux", run })).toEqual([21]);
  });

  it("killTree runs taskkill /T /F on Windows", async () => {
    const run = vi.fn((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(null));
    expect(await p.killTree(55, { platform: "win32", run })).toBe(true);
    expect(run).toHaveBeenCalledWith("taskkill", ["/PID", "55", "/T", "/F"], expect.anything(), expect.any(Function));
  });

  it("killTree signals the group on Linux", async () => {
    const kill = vi.fn();
    expect(await p.killTree(55, { platform: "linux", kill })).toBe(true);
    expect(kill).toHaveBeenCalledWith(-55, "SIGTERM");
  });

  it("spawnHidden hides the window and detaches", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }));
    p.spawnHidden("node", ["x"], { cwd: "/c" }, { spawnFn });
    expect(spawnFn).toHaveBeenCalledWith("node", ["x"], expect.objectContaining({ windowsHide: true, detached: true, cwd: "/c" }));
    expect(unref).toHaveBeenCalled();
  });

  it("shellCommand and npxCommand differ per platform", () => {
    expect(p.shellCommand("echo hi", "linux")).toEqual({ cmd: "bash", args: ["-l", "-c", "echo hi"] });
    expect(p.shellCommand("echo hi", "win32").args).toEqual(["/d", "/s", "/c", "echo hi"]);
    expect(p.npxCommand("win32")).toBe("npx.cmd");
    expect(p.npxCommand("linux")).toBe("npx");
  });
});
