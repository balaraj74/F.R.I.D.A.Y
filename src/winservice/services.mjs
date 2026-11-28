// Service definitions for the Windows supervisor. Pure data plus small resolvers: every OS lookup
// goes through `ctx` (platform, home, repoRoot, exists, env) so Linux unit tests can cover it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PORTS = {
  gateway: 18789,
  proxy: 8080,
  whisper: 18950,
  kokoro: 18951,
  supertonic: 18952,
};
export const PROXY_VERSION = "2.8.7";

/** Read ~/.friday/setup.json. Missing or invalid file gives null (callers use defaults). */
export function readSetup(file, readFile = (f) => fs.readFileSync(f, "utf8")) {
  try {
    const data = JSON.parse(readFile(file));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function makeContext(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const home = overrides.home ?? os.homedir();
  const pp = platform === "win32" ? path.win32 : path.posix;
  return {
    platform,
    home,
    pp,
    repoRoot:
      overrides.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
    exists: overrides.exists ?? ((p) => fs.existsSync(p)),
    env: overrides.env ?? process.env,
    nodePath: overrides.nodePath ?? process.execPath,
    gatewayPort: overrides.gatewayPort ?? PORTS.gateway,
    token: overrides.token ?? "",
  };
}

const first = (ctx, candidates) => candidates.find((c) => ctx.exists(c)) ?? null;

export function voicePaths(ctx) {
  const { pp, home } = ctx;
  const voice = pp.join(home, ".friday", "voice");
  const exe = ctx.platform === "win32" ? ".exe" : "";
  const wcpp = pp.join(voice, "whisper.cpp");
  const bin = first(ctx, [
    pp.join(wcpp, `whisper-server${exe}`),
    pp.join(wcpp, "build", "bin", `whisper-server${exe}`),
    pp.join(wcpp, "build", "bin", "Release", `whisper-server${exe}`),
    pp.join(wcpp, "Release", `whisper-server${exe}`),
  ]);
  const modelsDir = pp.join(wcpp, "models");
  const model = first(
    ctx,
    ["ggml-small.en.bin", "ggml-base.en.bin", "ggml-tiny.en.bin"].map((m) => pp.join(modelsDir, m)),
  );
  const vad = first(ctx, [pp.join(modelsDir, "ggml-silero-v5.1.2.bin")]);
  const venv = pp.join(voice, "supertonic", "venv");
  const py =
    ctx.platform === "win32"
      ? pp.join(venv, "Scripts", "python.exe")
      : pp.join(venv, "bin", "python");
  return { voice, bin, model, vad, py: ctx.exists(py) ? py : null };
}

function electronBinary(ctx) {
  const { pp, repoRoot } = ctx;
  const rel = ctx.platform === "win32" ? ["dist", "electron.exe"] : ["dist", "electron"];
  return first(ctx, [
    pp.join(repoRoot, "friday-hud", "node_modules", "electron", ...rel),
    pp.join(repoRoot, "node_modules", "electron", ...rel),
  ]);
}

/** Start order is dependsOn; every service binds loopback only. `enabledWhen(setup)` decides from setup.json. */
export function defineServices(ctx = makeContext()) {
  const { pp, repoRoot } = ctx;
  const voice = voicePaths(ctx);
  const win = ctx.platform === "win32";
  const voiceEnv = ctx.token ? { FRIDAY_VOICE_TOKEN: ctx.token } : {};
  const whisperArgs =
    voice.bin && voice.model
      ? [
          "-m",
          voice.model,
          "--host",
          "127.0.0.1",
          "--port",
          String(PORTS.whisper),
          "-t",
          String(Math.max(2, Math.min(8, os.cpus().length - 1))),
          "-bs",
          "1",
          "-bo",
          "1",
          ...(voice.vad ? ["--vad", "--vad-model", voice.vad] : []),
        ]
      : [];
  const electron = electronBinary(ctx);
  return [
    {
      name: "proxy",
      command: win ? "npx.cmd" : "npx",
      shell: win, // .cmd shims need a shell on current Node
      args: ["-y", `antigravity-claude-proxy@${PROXY_VERSION}`, "start", "--log"],
      cwd: repoRoot,
      env: {},
      healthPort: PORTS.proxy,
      dependsOn: [],
      // Only the default Antigravity brain needs the proxy.
      enabledWhen: (setup) => !setup || !setup.brain || setup.brain === "antigravity",
      available: () => true,
      // Raise the proxy's 16k output cap (idempotent; re-applied after npx re-downloads).
      async prepare() {
        const mod = await import(
          pathToFileURL(pp.join(repoRoot, "scripts", "patch-antigravity-proxy.mjs")).href
        );
        mod.patchProxy({ version: PROXY_VERSION });
      },
    },
    {
      name: "gateway",
      command: ctx.nodePath,
      args: [pp.join(repoRoot, "dist", "index.js"), "gateway", "--port", String(ctx.gatewayPort)],
      cwd: repoRoot,
      env: { FRIDAY_GATEWAY_PORT: String(ctx.gatewayPort) },
      healthPort: ctx.gatewayPort,
      dependsOn: ["proxy"],
      enabledWhen: () => true,
      available: () => ctx.exists(pp.join(repoRoot, "dist", "index.js")),
    },
    {
      name: "whisper",
      command: voice.bin ?? "whisper-server",
      args: whisperArgs,
      cwd: voice.voice,
      env: voiceEnv,
      healthPort: PORTS.whisper,
      dependsOn: ["gateway"],
      enabledWhen: () => true, // speech to text is always local
      available: () => Boolean(voice.bin && voice.model),
    },
    {
      name: "supertonic",
      command: voice.py ?? "python",
      args: [pp.join(repoRoot, "friday-hud", "voice", "supertonic-server.py")],
      cwd: repoRoot,
      env: { ...voiceEnv, FRIDAY_SUPERTONIC_PORT: String(PORTS.supertonic) },
      healthPort: PORTS.supertonic,
      dependsOn: ["gateway"],
      // Edge voice and "none" run no local TTS service.
      enabledWhen: (setup) => setup?.voice?.tts === "supertonic-gpu",
      available: () => Boolean(voice.py),
    },
    {
      name: "quickbar",
      stopOnCleanExit: true,
      command: electron ?? "electron",
      args: [pp.join(repoRoot, "quickbar", "windows")],
      cwd: repoRoot,
      env: {},
      healthPort: null,
      dependsOn: ["gateway"],
      enabledWhen: (setup) => setup?.quickbar?.enabled !== false,
      available: () => Boolean(electron) && ctx.exists(pp.join(repoRoot, "quickbar", "windows")),
    },
  ];
}

/** Services to run for this setup.json: enabled by setup, then topologically ordered by dependsOn. */
export function orderServices(defs, setup) {
  const enabled = defs.filter((d) => d.enabledWhen(setup));
  const names = new Set(enabled.map((d) => d.name));
  const done = new Set();
  const out = [];
  const visit = (d, trail = []) => {
    if (done.has(d.name)) return;
    if (trail.includes(d.name)) throw new Error(`dependency cycle at ${d.name}`);
    for (const dep of d.dependsOn) {
      const next = enabled.find((e) => e.name === dep);
      if (next) visit(next, [...trail, d.name]);
    }
    done.add(d.name);
    out.push(d);
  };
  enabled.forEach((d) => visit(d));
  return out.filter((d) => names.has(d.name));
}
