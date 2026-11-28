import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setup = createRequire(import.meta.url)("./setup.cjs") as any;
const repoRoot = path.resolve(__dirname, "..", "..");
const nvidia = { nvidia: true, name: "NVIDIA GeForce RTX 3060" };
const noGpu = { nvidia: false };

describe("detectGpu", () => {
  it("reads nvidia-smi csv output", () => {
    expect(setup.detectGpu({ nvidiaSmi: "NVIDIA GeForce RTX 4070 Laptop GPU\n" })).toEqual({
      nvidia: true,
      name: "NVIDIA GeForce RTX 4070 Laptop GPU",
    });
  });
  it("reads the nvidia-smi table", () => {
    const table = "| NVIDIA-SMI 551.23   Driver Version: 551.23 |\n|   0  NVIDIA GeForce RTX 3060   WDDM  | 00000000 |";
    expect(setup.detectGpu({ nvidiaSmi: table }).nvidia).toBe(true);
  });
  it("falls back to WMI adapter names", () => {
    expect(setup.detectGpu({ nvidiaSmi: "", wmi: "Intel(R) UHD Graphics\r\nNVIDIA GeForce GTX 1650\r\n" })).toEqual({
      nvidia: true,
      name: "NVIDIA GeForce GTX 1650",
    });
  });
  it("reports no NVIDIA GPU for Intel or AMD only, or empty input", () => {
    expect(setup.detectGpu({ wmi: "Intel(R) Iris(R) Xe Graphics\nAMD Radeon(TM) Graphics" })).toEqual(noGpu);
    expect(setup.detectGpu({ nvidiaSmi: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver." })).toEqual(noGpu);
    expect(setup.detectGpu()).toEqual(noGpu);
  });
});

describe("voice defaults", () => {
  it("preselects Supertonic GPU with NVIDIA and Edge without", () => {
    expect(setup.defaultVoice(nvidia).tts).toBe("supertonic-gpu");
    expect(setup.defaultVoice(noGpu)).toEqual({ tts: "edge", stt: "whisper-cpu" });
  });
  it("offers the GPU voice only with NVIDIA, and always No voice", () => {
    expect(setup.voiceOptions(noGpu).map((o: { id: string }) => o.id)).toEqual(["edge", "none"]);
    expect(setup.voiceOptions(nvidia).map((o: { id: string }) => o.id)).toEqual(["supertonic-gpu", "edge", "none"]);
  });
  it("refuses the GPU voice without a GPU and ignores unknown brains", () => {
    const c = setup.normalizeChoices({ brain: "openai", voice: { tts: "supertonic-gpu" } }, noGpu);
    expect(c.voice.tts).toBe("edge");
    expect(c.brain).toBe("antigravity");
  });
});

describe("plan", () => {
  const ids = (p: { id: string }[]) => p.map((s) => s.id);
  it("skips all voice steps for No voice", () => {
    const plan = setup.buildPlan(setup.normalizeChoices({ voice: { tts: "none" }, background: false }, nvidia));
    expect(ids(plan)).toEqual(["config", "proxy"]);
  });
  it("Edge installs only speech to text; Supertonic adds the GPU voice", () => {
    expect(ids(setup.buildPlan(setup.normalizeChoices({}, noGpu)))).toEqual(["config", "proxy", "voice-stt", "services"]);
    expect(ids(setup.buildPlan(setup.normalizeChoices({ computerControl: { consented: true } }, nvidia)))).toEqual([
      "config", "proxy", "voice-stt", "voice-tts", "computer-control", "services",
    ]);
  });
  it("registers computer control only after consent", () => {
    expect(ids(setup.buildPlan(setup.normalizeChoices({ computerControl: { consented: false } }, noGpu)))).not.toContain("computer-control");
  });
  it("adds download sizes up front", () => {
    const plan = setup.buildPlan(setup.normalizeChoices({}, noGpu));
    expect(setup.totalDownloadMB(plan)).toBeGreaterThan(100);
  });
  it("makes the voice installer command with the right device", () => {
    const state = { voice: { tts: "supertonic-gpu", stt: "whisper-gpu" } };
    const cmd = setup.stepCommand({ id: "voice-tts" }, { platform: "win32", repoRoot: "C:\\f", home: "C:\\u", state });
    expect(cmd.file).toBe("powershell.exe");
    expect(cmd.args).toContain("supertonic");
    expect(cmd.args.join(" ")).toContain("setup-windows.ps1");
  });
});

function memStore() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const fake = {
    mkdirSync: () => {},
    writeFileSync: (f: string, d: string) => { calls.push(`write:${path.basename(f)}`); files.set(f, d); },
    renameSync: (a: string, b: string) => { calls.push("rename"); files.set(b, files.get(a) as string); files.delete(a); },
    readFileSync: (f: string) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); },
  };
  return { files, calls, store: setup.createStore({ fs: fake, file: "/h/.friday/setup.json", pid: 7 }) };
}

describe("store", () => {
  it("writes a temp file then renames it over setup.json", () => {
    const m = memStore();
    m.store.write({ version: 1 });
    expect(m.calls).toEqual(["write:setup.json.7.tmp", "rename"]);
    expect(m.store.read()).toEqual({ version: 1 });
    expect([...m.files.keys()]).toEqual(["/h/.friday/setup.json"]);
  });
  it("returns null for a missing or corrupt file", () => {
    const m = memStore();
    expect(m.store.read()).toBeNull();
    m.files.set("/h/.friday/setup.json", "{nope");
    expect(m.store.read()).toBeNull();
  });
});

function newRun(execStep: (s: { id: string }) => Promise<{ ok: boolean; error?: string }>, choices = {}) {
  const m = memStore();
  const c = setup.normalizeChoices(choices, noGpu);
  const plan = setup.buildPlan(c);
  const state = setup.initialState(c, noGpu, plan);
  const events: { type: string; id?: string; status?: string }[] = [];
  const runner = setup.createRunner({ plan, state, store: m.store, execStep, notify: (e: never) => events.push(e), now: () => new Date("2026-01-01T00:00:00Z") });
  return { m, plan, state, runner, events };
}

describe("runner", () => {
  it("runs steps in order and completes with a timestamp", async () => {
    const order: string[] = [];
    const r = newRun(async (s) => { order.push(s.id); return { ok: true }; });
    const res = await r.runner.run();
    expect(res.complete).toBe(true);
    expect(order).toEqual(["config", "proxy", "voice-stt", "services"]);
    expect(r.state.completedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(setup.isSetupComplete(r.m.store.read())).toBe(true);
  });
  it("stops at a failed required step and never completes", async () => {
    const r = newRun(async (s) => (s.id === "proxy" ? { ok: false, error: "no network" } : { ok: true }));
    const res = await r.runner.run();
    expect(res).toEqual({ complete: false, stoppedAt: "proxy" });
    expect(r.state.steps.proxy).toBe("failed");
    expect(r.state.steps["voice-stt"]).toBe("pending");
    expect(r.state.completedAt).toBeUndefined();
  });
  it("turns a thrown error into a failed step", async () => {
    const r = newRun(async () => { throw new Error("boom"); });
    await r.runner.run();
    expect(r.state.lastError.message).toBe("boom");
  });
  it("offers Retry and Skip for optional steps, never Skip for required", async () => {
    let fail = true;
    const r = newRun(async (s) => (s.id === "voice-stt" && fail ? { ok: false, error: "x" } : { ok: true }));
    expect((await r.runner.run()).stoppedAt).toBe("voice-stt");
    expect(r.runner.skip("config")).toBe(false);
    fail = false;
    expect((await r.runner.retry("voice-stt")).complete).toBe(true);
    const r2 = newRun(async (s) => (s.id === "voice-stt" ? { ok: false, error: "x" } : { ok: true }));
    await r2.runner.run();
    expect(r2.runner.skip("voice-stt")).toBe(true);
    expect((await r2.runner.run()).complete).toBe(true);
    expect(r2.state.steps["voice-stt"]).toBe("skipped");
  });
  it("resumes at the first incomplete step from a saved state", async () => {
    const r = newRun(async (s) => (s.id === "voice-stt" ? { ok: false, error: "x" } : { ok: true }));
    await r.runner.run();
    const saved = r.m.store.read();
    const plan = setup.planFromState(saved);
    expect(setup.firstIncomplete(saved, plan)).toBe("voice-stt");
    const exec = vi.fn(async () => ({ ok: true }));
    const runner = setup.createRunner({ plan, state: saved, store: r.m.store, execStep: exec });
    await runner.run();
    expect(exec.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["voice-stt", "services"]);
  });
  it("stops when cancelled", async () => {
    const r = newRun(async (s) => { if (s.id === "config") r.runner.cancel(); return { ok: true }; });
    const res = await r.runner.run();
    expect(res.cancelled).toBe(true);
    expect(r.state.completedAt).toBeUndefined();
  });
});

describe("progress lines", () => {
  it("parses installer markers and ignores other output", () => {
    expect(setup.parseProgressLine("##PROGRESS 40 Downloading model")).toEqual({ percent: 40, message: "Downloading model" });
    expect(setup.parseProgressLine("##SIZE 142")).toEqual({ sizeMB: 142 });
    expect(setup.parseProgressLine("plain log line")).toBeNull();
  });
});

describe("config and workspace", () => {
  it("builds a loopback config with the proxy at 127.0.0.1:8080", () => {
    const c = setup.buildFridayConfig({ token: "t", workspace: "C:\\Users\\a b\\friday" });
    expect(c.gateway.bind).toBe("loopback");
    expect(c.models.providers["antigravity-proxy"].baseUrl).toBe("http://127.0.0.1:8080");
  });
  it("registers the desktop MCP without dropping other servers", () => {
    const c = setup.withDesktopMcp({ mcp: { servers: { google: { command: "x" } } } }, { python: "p", server: "s" });
    expect(Object.keys(c.mcp.servers)).toEqual(["google", "desktop"]);
  });
  it("never overwrites an existing config or workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-setup-"));
    const file = path.join(dir, ".friday", "friday.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "keep");
    expect(setup.ensureFridayConfig({ fs, file, workspace: dir, randomToken: () => "t" }).created).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
    const ws = path.join(dir, "friday");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "SOUL.md"), "mine");
    expect(setup.createWorkspace({ fs, repoRoot, workspace: ws, platform: "win32", vars: {} }).created).toBe(false);
    expect(fs.readFileSync(path.join(ws, "SOUL.md"), "utf8")).toBe("mine");
  });
  it("renders Windows templates, keeps the credit and has no Linux tool advice", () => {
    const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "friday-ws-")), "friday");
    setup.createWorkspace({ fs, repoRoot, workspace: ws, platform: "win32", vars: { NAME: "Ana", ADDRESS: "Boss", TIMEZONE: "UTC" } });
    const all = ["SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md"].map((f) => fs.readFileSync(path.join(ws, f), "utf8")).join("\n");
    expect(all).toContain("Balaraj built FRIDAY");
    expect(all).not.toMatch(/\{\{/);
    expect(all).toContain("PowerShell");
    expect(all).not.toMatch(/wmctrl -|playerctl [a-z]|tmux (new|send)|zsh -/);
  });
  it("leaves Linux templates unchanged in selection", () => {
    expect(setup.templateSources("linux")).toEqual({ dir: "", files: ["SOUL.md", "IDENTITY.md", "USER.md"] });
  });
});
