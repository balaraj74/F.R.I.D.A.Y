#!/usr/bin/env node
// Cross-platform entry for the package scripts start:all, stop:all, setup and hud:widget.
// Linux/macOS: runs the existing bash script unchanged. Windows: Node equivalents.
//   node scripts/run-platform.mjs start|stop|setup|widget [args...]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [action, ...rest] = process.argv.slice(2);
const bashScripts = { start: "start.sh", stop: "stop.sh", setup: "setup.sh", widget: "launch_hud_widget.sh" };

if (!bashScripts[action]) {
  console.error("usage: run-platform.mjs start|stop|setup|widget [args...]");
  process.exit(2);
}

if (process.platform !== "win32") {
  const r = spawnSync("bash", [path.join(repo, bashScripts[action]), ...rest], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const platform = createRequire(import.meta.url)(path.join(repo, "friday-hud", "electron", "platform.cjs"));
const logs = path.join(os.homedir(), ".friday", "logs");
fs.mkdirSync(logs, { recursive: true });
const say = (m) => console.log(`[FRIDAY] ${m}`);
const portUp = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
const waitPort = async (port, ms) => {
  for (let t = 0; t < ms; t += 400) {
    if (await portUp(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};
const logFd = (name) => fs.openSync(path.join(logs, name), "a");
const run = (cmd, args, cwd = repo) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
function electronBin() {
  for (const base of [path.join(repo, "friday-hud"), repo]) {
    const exe = path.join(base, "node_modules", "electron", "dist", "electron.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
function launchHud(args) {
  const bin = electronBin();
  if (!bin) {
    console.error("Electron is not installed. Run: pnpm setup");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(repo, "friday-hud", "dist", "index.html"))) run("pnpm", ["build"], path.join(repo, "friday-hud"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  say("Launching the HUD...");
  platform.spawnHidden(bin, [path.join(repo, "friday-hud"), ...args], { env, cwd: path.join(repo, "friday-hud") });
}

if (action === "widget") {
  launchHud(rest);
} else if (action === "start") {
  if (await portUp(8080)) say("Proxy already active on :8080");
  else {
    say("Starting the Antigravity proxy...");
    try {
      const mod = await import(new URL("./patch-antigravity-proxy.mjs", import.meta.url).href);
      mod.patchProxy({ version: "2.8.7" });
    } catch (e) { say(`proxy patch skipped: ${e.message}`); }
    const fd = logFd("proxy.log");
    platform.spawnHidden("npx.cmd", ["-y", "antigravity-claude-proxy@2.8.7", "start", "--log"], { stdio: ["ignore", fd, fd], shell: true, cwd: repo });
    say((await waitPort(8080, 30000)) ? "Proxy online on http://127.0.0.1:8080" : "Proxy still starting (continuing)");
  }
  if (await portUp(18789)) say("Gateway already active on :18789");
  else {
    say("Starting the gateway...");
    const fd = logFd("gateway.log");
    platform.spawnHidden(process.execPath, [path.join(repo, "friday.mjs"), "gateway", "--force"], { stdio: ["ignore", fd, fd], cwd: repo });
    say((await waitPort(18789, 40000)) ? "Gateway online on ws://127.0.0.1:18789" : `Gateway initialising (log: ${path.join(logs, "gateway.log")})`);
  }
  launchHud(rest);
} else if (action === "stop") {
  say("Stopping HUD, gateway and proxy...");
  spawnSync("taskkill", ["/F", "/FI", "WINDOWTITLE eq FRIDAY*", "/IM", "electron.exe"], { stdio: "ignore" });
  for (const port of [18789, 8080]) {
    for (const pid of await platform.findPidByPort(port)) await platform.killTree(pid);
  }
  say("Stopped.");
} else if (action === "setup") {
  for (const cmd of ["node", "pnpm"]) {
    if (spawnSync(cmd, ["--version"], { shell: true }).status !== 0) {
      console.error(`${cmd} is not installed. On Windows run install.ps1 for a full bootstrap.`);
      process.exit(1);
    }
  }
  run("pnpm", ["install"]);
  run("pnpm", ["build"]);
  run("pnpm", ["install"], path.join(repo, "friday-hud"));
  run("pnpm", ["build"], path.join(repo, "friday-hud"));
  const home = path.join(os.homedir(), ".friday");
  for (const d of ["logs", "memory", "run"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  say("Setup complete. Start with: pnpm start:all   (background mode: node scripts/friday-service.mjs install)");
}
