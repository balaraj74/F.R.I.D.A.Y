// Throwaway code sandbox (bubblewrap): FRIDAY can write and run Python / Node / Bash on her own
// without any way to touch Sir's files. The sandbox sees a read-only system (/usr, a few /etc
// files), an empty /tmp, and one scratch folder as its home; no network unless asked for;
// CPU time, file size and process count are capped; everything dies with the run.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

export type SandboxLanguage = "python" | "node" | "bash";

export type SandboxResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Host path of the scratch folder (files the code wrote are left here). */
  workdir: string;
  files: string[];
};

const OUTPUT_CAP = 50_000;
const RUNTIMES: Record<SandboxLanguage, { file: string; argv: string[] }> = {
  python: { file: "main.py", argv: ["/usr/bin/python3", "main.py"] },
  node: { file: "main.mjs", argv: ["/usr/local/bin/node", "main.mjs"] },
  bash: { file: "main.sh", argv: ["/bin/bash", "main.sh"] },
};

export function sandboxAvailable(): boolean {
  return fs.existsSync("/usr/bin/bwrap");
}

export function sandboxRunsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "sandbox", "runs");
}

/** bubblewrap arguments for one run (exported for tests). */
export function bwrapArgs(params: {
  workdir: string;
  network: boolean;
  cpuSeconds: number;
}): string[] {
  const args = [
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/alternatives",
    "/etc/alternatives",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/ca-certificates",
    "/etc/ca-certificates",
    "--ro-bind-try",
    "/etc/localtime",
    "/etc/localtime",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    params.workdir,
    "/work",
    "--chdir",
    "/work",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--hostname",
    "sandbox",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/work",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
  ];
  if (params.network) {
    // Network on request only; DNS needs the resolver config.
    args.push(
      "--share-net",
      "--ro-bind-try",
      "/etc/resolv.conf",
      "/etc/resolv.conf",
      "--ro-bind-try",
      "/etc/hosts",
      "/etc/hosts",
    );
  }
  // Resource caps inside the sandbox: CPU seconds, 200 MB per file, 256 processes.
  args.push(
    "/usr/bin/prlimit",
    `--cpu=${params.cpuSeconds}`,
    "--fsize=209715200",
    "--nproc=256",
    "--",
  );
  return args;
}

function cap(s: string) {
  return s.length > OUTPUT_CAP
    ? `${s.slice(0, OUTPUT_CAP)}\n…[${s.length - OUTPUT_CAP} more characters cut]`
    : s;
}

export async function runSandboxed(params: {
  language: SandboxLanguage;
  code: string;
  timeoutMs?: number;
  network?: boolean;
  signal?: AbortSignal;
  stateDir?: string;
}): Promise<SandboxResult> {
  if (!sandboxAvailable())
    throw new Error("bubblewrap (bwrap) is not installed, so the code sandbox is unavailable");
  const runtime = RUNTIMES[params.language];
  if (!runtime) throw new Error(`unsupported language: ${params.language}`);
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 60_000, 1_000), 600_000);
  const runsDir = sandboxRunsDir(params.stateDir);
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  const workdir = fs.mkdtempSync(
    path.join(
      runsDir,
      `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}-`,
    ),
  );
  fs.writeFileSync(path.join(workdir, runtime.file), params.code, { mode: 0o600 });

  const args = [
    ...bwrapArgs({
      workdir,
      network: Boolean(params.network),
      cpuSeconds: Math.ceil(timeoutMs / 1000) + 1,
    }),
    ...runtime.argv,
  ];
  const started = Date.now();
  return await new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", args, { stdio: ["ignore", "pipe", "pipe"], env: {} });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      if (stdout.length <= OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length <= OUTPUT_CAP) stderr += d.toString();
    });
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    params.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", kill);
      const files = fs.readdirSync(workdir).filter((f) => f !== runtime.file);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: cap(stdout),
        stderr: cap(stderr),
        durationMs: Date.now() - started,
        workdir,
        files,
      });
    });
  });
}

/** Drop scratch folders older than `maxAgeMs` (default 3 days). */
export function pruneSandboxRuns(maxAgeMs = 3 * 86400_000, stateDir?: string): number {
  const dir = sandboxRunsDir(stateDir);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {}
  return removed;
}
