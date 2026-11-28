#!/usr/bin/env node
// friday-service install|start|stop|status|uninstall  (Windows Task Scheduler backend)
//   install     write the hidden launcher + task XML, register the logon task, start it
//   start/stop  start the task / stop the supervisor and every service it runs
//   status      each service as running, stopped or failed with its port
//   uninstall   stop, unregister the task, move the files we wrote to ~/.friday/trash
// Nothing under ~/.friday is deleted; files we created are moved to the trash folder.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherVbs, taskXml } from "../src/winservice/task-xml.mjs";

export const TASK_NAME = "FRIDAY\\Supervisor";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

export function paths(home = os.homedir(), pp = path) {
  const run = pp.join(home, ".friday", "run");
  return {
    run,
    status: pp.join(run, "status.json"),
    pid: pp.join(run, "supervisor.pid"),
    vbs: pp.join(run, "supervisor-launch.vbs"),
    xml: pp.join(run, "supervisor-task.xml"),
    trash: pp.join(home, ".friday", "trash"),
  };
}

/** Build the launcher and task definition (pure; used by install and by tests). */
export function buildInstall({ home, node, repo, userId, pp = path.win32 }) {
  const supervisor = pp.join(repo, "src", "winservice", "supervisor.mjs");
  const p = paths(home, pp);
  return {
    vbs: launcherVbs({ command: node, args: [supervisor] }),
    xml: taskXml({ command: "wscript.exe", args: ["//B", "//Nologo", p.vbs], workDir: repo, userId }),
    paths: p,
  };
}

const sh = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));

const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};
function trashMove(file, trash) {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(file, path.join(trash, `${path.basename(file)}.${Date.now()}`));
}
const needWindows = () => {
  if (process.platform !== "win32") {
    console.error("friday-service: the Task Scheduler backend only works on Windows (Linux uses scripts/always-on.sh).");
    process.exit(2);
  }
};

export function formatStatus(status, supervisorAlive) {
  if (!status?.services) return supervisorAlive ? "supervisor running, no status yet" : "not running (no status.json)";
  const lines = Object.entries(status.services).map(([name, s]) => {
    const state = !supervisorAlive && s.state === "running" ? "stopped" : s.state;
    return `${name.padEnd(11)} ${state.padEnd(9)} ${s.port ? `port ${s.port}` : "-"}${s.reason ? `  (${s.reason})` : ""}`;
  });
  return lines.join("\n");
}

async function stopSupervisor(p) {
  const pid = Number(fs.existsSync(p.pid) ? fs.readFileSync(p.pid, "utf8") : 0);
  await sh("schtasks", ["/End", "/TN", TASK_NAME]);
  if (pid && alive(pid)) await sh("taskkill", ["/PID", String(pid), "/T", "/F"]);
  try { fs.rmSync(p.pid, { force: true }); } catch { /* ignore */ }
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const p = paths();
  if (cmd === "install") {
    if (argv.includes("--print-xml")) {
      const b = buildInstall({ home: os.homedir(), node: process.execPath, repo: repoRoot, userId: process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username });
      process.stdout.write(b.xml);
      return;
    }
    needWindows();
    const userId = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
    const b = buildInstall({ home: os.homedir(), node: process.execPath, repo: repoRoot, userId });
    fs.mkdirSync(p.run, { recursive: true });
    fs.writeFileSync(p.vbs, b.vbs);
    fs.writeFileSync(p.xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(b.xml, "utf16le")]));
    const r = await sh("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", p.xml, "/F"]);
    if (!r.ok) {
      console.error(`friday-service: could not register the task: ${r.stderr.trim()}`);
      process.exit(1);
    }
    await sh("schtasks", ["/Run", "/TN", TASK_NAME]);
    console.log("FRIDAY background services installed and started (they now start at logon).");
  } else if (cmd === "start") {
    needWindows();
    const r = await sh("schtasks", ["/Run", "/TN", TASK_NAME]);
    if (!r.ok) {
      console.error(`friday-service: ${r.stderr.trim() || "task not installed; run install first"}`);
      process.exit(1);
    }
    console.log("started");
  } else if (cmd === "stop") {
    needWindows();
    await stopSupervisor(p);
    console.log("stopped");
  } else if (cmd === "status") {
    const pid = Number(fs.existsSync(p.pid) ? fs.readFileSync(p.pid, "utf8") : 0);
    const status = readJson(p.status);
    console.log(formatStatus(status, Boolean(pid && alive(pid))));
    if (argv.includes("--json")) console.log(JSON.stringify(status));
  } else if (cmd === "uninstall") {
    needWindows();
    await stopSupervisor(p);
    await sh("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    trashMove(p.vbs, p.trash);
    trashMove(p.xml, p.trash);
    console.log("FRIDAY background services removed (your data is untouched).");
  } else {
    console.error("usage: friday-service install|start|stop|status|uninstall");
    process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
