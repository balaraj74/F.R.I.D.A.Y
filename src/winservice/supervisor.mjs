// FRIDAY Windows supervisor. One Task Scheduler logon task runs this file; it starts the enabled
// services in dependency order, hidden, restarts crashed ones with backoff and writes
// ~/.friday/run/status.json. All side effects are injected so tests drive it with fakes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineServices, makeContext, orderServices, readSetup } from "./services.mjs";

export const RESTART_WINDOW_MS = 5 * 60 * 1000;
export const MAX_RESTARTS = 5;
export const MAX_BACKOFF_MS = 20_000; // restart always lands inside the 30 s requirement

/** Delay before restart attempt number `attempt` (0-based, within the window): 1, 2, 4, 8, 16 s. */
export const backoffMs = (attempt) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function tcpUp(port, host = "127.0.0.1", timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function createSupervisor({
  services,
  setup = null,
  spawn = nodeSpawn,
  clock = realClock,
  probePort = tcpUp,
  writeStatus = () => {},
  openLog = () => "ignore",
  kill = () => {},
  log = () => {},
  startTimeoutMs = 120_000,
  pollMs = 500,
}) {
  const order = orderServices(services, setup);
  const entries = new Map();
  let stopping = false;

  const snapshot = () => {
    const out = {};
    for (const d of services) {
      const e = entries.get(d.name);
      out[d.name] = e
        ? {
            state: e.state,
            pid: e.pid ?? null,
            since: e.since,
            restarts: e.restarts,
            ...(d.healthPort ? { port: d.healthPort } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
          }
        : {
            state: "stopped",
            pid: null,
            since: null,
            restarts: 0,
            ...(d.healthPort ? { port: d.healthPort } : {}),
          };
    }
    return { services: out };
  };
  const publish = () => {
    try {
      writeStatus(snapshot());
    } catch (err) {
      log(`status write failed: ${err?.message ?? err}`);
    }
  };
  const setState = (e, state, reason) => {
    e.state = state;
    e.since = new Date(clock.now()).toISOString();
    e.reason = reason;
    publish();
  };

  async function waitForPort(def, e) {
    if (!def.healthPort) return true;
    const deadline = clock.now() + startTimeoutMs;
    while (!stopping && e.child && clock.now() < deadline) {
      if (await probePort(def.healthPort)) return true;
      await clock.sleep(pollMs);
    }
    return false;
  }

  /** Mark running once the port answers (without blocking restart handling). */
  async function markUp(def, e, child) {
    const ok = await waitForPort(def, e);
    if (ok && e.child === child && !stopping) setState(e, "running");
    return ok;
  }

  function launch(def, e) {
    const logTarget = openLog(def.name);
    let child;
    try {
      child = spawn(def.command, def.args, {
        cwd: def.cwd,
        env: { ...process.env, ...def.env },
        windowsHide: true,
        shell: Boolean(def.shell),
        stdio: ["ignore", logTarget, logTarget],
      });
    } catch (err) {
      e.child = null;
      onExit(def, e, null, `spawn failed: ${err?.message ?? err}`);
      return null;
    }
    e.child = child;
    e.pid = child.pid;
    setState(e, "starting");
    let handled = false;
    const once = (code, why) => {
      if (handled) return;
      handled = true;
      onExit(def, e, code, why, child);
    };
    child.on?.("error", (err) => once(null, `spawn error: ${err?.message ?? err}`));
    child.on?.("exit", (code, signal) => once(code, `exited with ${signal ?? code}`));
    return child;
  }

  function onExit(def, e, code, why, child) {
    if (child && e.child !== child) return;
    e.child = null;
    e.pid = null;
    if (stopping) return setState(e, "stopped");
    if (def.stopOnCleanExit && code === 0) return setState(e, "stopped", "quit by user");
    const now = clock.now();
    e.attempts = e.attempts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (e.attempts.length >= MAX_RESTARTS) {
      log(`${def.name}: giving up after ${MAX_RESTARTS} restarts in 5 minutes (${why})`);
      return setState(
        e,
        "failed",
        `${why}; gave up after ${MAX_RESTARTS} restarts within 5 minutes`,
      );
    }
    const delay = backoffMs(e.attempts.length);
    e.attempts.push(now);
    e.restarts += 1;
    setState(e, "starting", `${why}; restarting in ${Math.round(delay / 1000)}s`);
    e.timer = clock.setTimeout(() => {
      e.timer = null;
      if (stopping) return;
      const child2 = launch(def, e);
      if (child2) void markUp(def, e, child2);
    }, delay);
  }

  async function start() {
    stopping = false;
    for (const def of services) {
      entries.set(def.name, {
        state: "stopped",
        pid: null,
        since: null,
        restarts: 0,
        attempts: [],
        child: null,
        timer: null,
      });
    }
    publish();
    for (const def of order) {
      const e = entries.get(def.name);
      if (!def.available()) {
        setState(e, "failed", "not installed");
        continue;
      }
      try {
        await def.prepare?.();
      } catch (err) {
        log(`${def.name}: prepare failed: ${err?.message ?? err}`);
      }
      const child = launch(def, e);
      if (!child) continue;
      // Ordering: the next service starts only after this one's port answers (or the wait times out).
      const ok = await markUp(def, e, child);
      if (!ok && !stopping)
        log(
          `${def.name}: port ${def.healthPort} not answering after ${startTimeoutMs} ms; continuing`,
        );
    }
  }

  async function stop() {
    stopping = true;
    // Reverse order: dependents first.
    for (const def of [...order].reverse()) {
      const e = entries.get(def.name);
      if (!e) continue;
      if (e.timer) clock.clearTimeout(e.timer);
      e.timer = null;
      const pid = e.pid;
      e.child = null;
      if (pid) await kill(pid);
      setState(e, "stopped");
    }
  }

  return { start, stop, snapshot, order: () => order.map((d) => d.name) };
}

// ---- real process wiring ------------------------------------------------------------------

const HOME_DIR = (ctx) => ctx.pp.join(ctx.home, ".friday");

/** runtime.json with a managed token: keep an existing managed one, otherwise create it (owner-only). */
export function ensureRuntime(
  ctx,
  {
    fsApi = fs,
    randomHex = () => crypto.randomBytes(16).toString("hex"),
    restrict = () => {},
  } = {},
) {
  const file = ctx.pp.join(HOME_DIR(ctx), "voice", "runtime.json");
  try {
    const cur = JSON.parse(fsApi.readFileSync(file, "utf8"));
    if (cur?.managed === true && typeof cur.token === "string" && cur.token) return cur;
  } catch {
    // create below
  }
  const runtime = {
    managed: true,
    token: randomHex(),
    ports: { whisper: 18950, kokoro: 18951, supertonic: 18952 },
  };
  fsApi.mkdirSync(ctx.pp.dirname(file), { recursive: true });
  fsApi.writeFileSync(file, JSON.stringify(runtime), { mode: 0o600 });
  restrict(file);
  return runtime;
}

function gatewayPortFrom(ctx) {
  try {
    const cfg = JSON.parse(fs.readFileSync(ctx.pp.join(HOME_DIR(ctx), "friday.json"), "utf8"));
    return Number(cfg?.gateway?.port) || 18789;
  } catch {
    return 18789;
  }
}

/** Limit a file to the current user on Windows (best effort; the file is already under the profile). */
function restrictToUser(file) {
  if (process.platform !== "win32") return;
  execFile(
    "icacls",
    [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`],
    { windowsHide: true },
    () => {},
  );
}

export async function runSupervisor() {
  const base = makeContext();
  const dir = HOME_DIR(base);
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const runtime = ensureRuntime(base, { restrict: restrictToUser });
  const ctx = makeContext({ gatewayPort: gatewayPortFrom(base), token: runtime.token });
  const setup = readSetup(path.join(dir, "setup.json"));
  const statusFile = path.join(runDir, "status.json");
  const killTree = (pid) =>
    new Promise((resolve) => {
      if (process.platform === "win32")
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
          resolve(),
        );
      else {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        resolve();
      }
    });
  const sup = createSupervisor({
    services: defineServices(ctx),
    setup,
    writeStatus: (s) => {
      const tmp = `${statusFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, statusFile);
    },
    openLog: (name) => fs.openSync(path.join(logDir, `${name}.log`), "a"),
    kill: killTree,
    log: (m) =>
      fs.appendFileSync(path.join(logDir, "supervisor.log"), `${new Date().toISOString()} ${m}\n`),
  });
  fs.writeFileSync(path.join(runDir, "supervisor.pid"), String(process.pid));
  const shutdown = async () => {
    await sup.stop();
    try {
      fs.rmSync(path.join(runDir, "supervisor.pid"), { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await sup.start();
  setInterval(() => {}, 1 << 30); // stay alive; children are monitored through their exit events
  return sup;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisor().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
