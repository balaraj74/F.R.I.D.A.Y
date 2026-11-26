// Earned trust (autonomy, phase 2): instead of autonomy being simply on or off, each kind of
// action FRIDAY takes builds a track record. When she acts on her own (heartbeat, cron), an
// action kind runs without asking only once it has a clean record; otherwise it goes to Sir
// for approval. Some kinds (pushing, publishing, messaging other people) never auto-promote.
// Hard-never commands (autonomy-policy.ts) always ask, whatever the record says.
//
// Every autonomous action is logged with an undo hint (and, for file writes, a snapshot that
// `friday trust undo <id>` restores) for the morning brief.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

export const TRUST_THRESHOLD = 5;

export type KindRecord = {
  ok: number;
  fail: number;
  /** Consecutive clean runs since the last failure. */
  streak: number;
  lastOkAt?: string;
  lastFailAt?: string;
  /** Sir granted this kind outright / took it away. */
  granted?: boolean;
  revoked?: boolean;
};

type TrustFile = { version: 1; kinds: Record<string, KindRecord>; lastBriefAt?: string };

export type AutonomousAction = {
  id: string;
  at: string;
  kinds: string[];
  /** Command or "tool: summary". */
  what: string;
  ok: boolean;
  sessionKey?: string;
  cwd?: string;
  undo?: string;
  /** Snapshot directory for file changes (restored by `friday trust undo`). */
  snapshot?: string;
};

export function trustDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "autonomy");
}

function trustFile(stateDir?: string) {
  return path.join(trustDir(stateDir), "trust.json");
}

function actionsFile(stateDir?: string) {
  return path.join(trustDir(stateDir), "actions.jsonl");
}

export function loadTrust(stateDir?: string): TrustFile {
  try {
    const data = JSON.parse(fs.readFileSync(trustFile(stateDir), "utf-8")) as TrustFile;
    return { version: 1, kinds: data.kinds ?? {}, lastBriefAt: data.lastBriefAt };
  } catch {
    return { version: 1, kinds: {} };
  }
}

function saveTrust(data: TrustFile, stateDir?: string) {
  const file = trustFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- Classifying shell commands into action kinds --------------------------------------

function segments(command: string): string[] {
  return command
    .replace(/\$\(([^)]*)\)/g, " ; $1 ; ")
    .replace(/`([^`]*)`/g, " ; $1 ; ")
    .split(/\|\||&&|[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function argvOf(segment: string): string[] {
  const argv = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
    w.replace(/^["']|["']$/g, ""),
  );
  while (argv.length) {
    const w = argv[0];
    if (
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ||
      /^(sudo|doas|nice|time|nohup|command|exec|env|timeout)$/.test(w)
    ) {
      argv.shift();
      while (argv[0]?.startsWith("-") || /^\d+[smh]?$/.test(argv[0] ?? "")) argv.shift();
    } else break;
  }
  return argv;
}

// Commands that only look at things. Running them never needs trust.
const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "rg",
  "ag",
  "wc",
  "du",
  "df",
  "free",
  "ps",
  "top",
  "htop",
  "uptime",
  "date",
  "whoami",
  "id",
  "echo",
  "printf",
  "pwd",
  "which",
  "type",
  "file",
  "stat",
  "tree",
  "jq",
  "yq",
  "awk",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "diff",
  "cmp",
  "md5sum",
  "sha256sum",
  "uname",
  "hostname",
  "lsblk",
  "lscpu",
  "lsusb",
  "lspci",
  "ss",
  "netstat",
  "ip",
  "ping",
  "dig",
  "nslookup",
  "host",
  "env",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "[",
  "true",
  "false",
  "sleep",
  "nproc",
  "sensors",
  "nvidia-smi",
  "journalctl",
  "pgrep",
  "xdg-mime",
  "man",
  "help",
  "cal",
  "bc",
  "seq",
  "xargs",
  "tee",
]);
const READ_SUBCOMMANDS: Record<string, RegExp> = {
  git: /^(status|log|diff|show|blame|branch|remote|fetch|rev-parse|ls-files|describe|shortlog|tag|config|grep|reflog|stash list)$/,
  systemctl:
    /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat)$/,
  docker: /^(ps|images|logs|inspect|stats|version|info)$/,
  npm: /^(ls|list|view|info|outdated|audit|config|why|-v|--version)$/,
  pnpm: /^(ls|list|why|outdated|audit|-v|--version)$/,
  pip: /^(list|show|freeze|check)$/,
  gh: /^(status|auth)$/,
  friday: /^(status|health|autonomy|commitments|trace|mcp|trust|sessions|logs)$/,
  apt: /^(list|show|search|policy)$/,
  snap: /^(list|info|find)$/,
  flatpak: /^(list|info|search)$/,
  nmcli: /^(general|device|connection|radio)$/,
  gsettings: /^(get|list-keys|list-schemas|list-recursively|range)$/,
  tmux: /^(ls|list-sessions|list-windows|capture-pane|has-session)$/,
};
const MULTI =
  /^(git|systemctl|docker|npm|pnpm|yarn|bun|pip|pip3|gh|friday|apt|apt-get|snap|flatpak|kubectl|cargo|go|nmcli|gsettings|tmux|uv)$/;

// Kinds that always go to Sir when FRIDAY acts on her own, however clean the record.
const NEVER_AUTO: Array<[RegExp, string]> = [
  [/^git push$/, "pushes code to a remote"],
  [/^(npm|pnpm|yarn|bun) publish$/, "publishes a package"],
  [/^docker push$/, "pushes an image"],
  [/^gh (pr|issue|release|repo|gist)$/, "writes to GitHub"],
  [/^twine$/, "publishes a package"],
  [/^net:send$/, "sends data to a web service"],
  [/^message:others$/, "messages someone other than Sir"],
  [/^mcp:browser$/, "acts on websites (clicking, typing, submitting)"],
  [/^mcp:send$/, "sends, replies to, forwards or deletes messages on Sir's behalf"],
  [/^screen:look$/, "looks at Sir's screen"],
  [/^mcp:desktop$/, "controls Sir's mouse and keyboard"],
  [/^code:merge$/, "changes Sir's own branches"],
  [/^mcp:github$/, "writes to GitHub"],
  [/^mcp:serena$/, "edits Sir's code directly"],
];

/** Action kinds a shell command performs ([] = read-only). */
export function commandKinds(command: string): string[] {
  const kinds = new Set<string>();
  for (const seg of segments(command)) {
    const argv = argvOf(seg);
    const cmd = argv[0]?.split("/").pop();
    if (!cmd) continue;
    if (cmd === "curl" || cmd === "wget" || cmd === "http") {
      const rest = argv.slice(1).join(" ");
      if (
        /(^|\s)(-X\s*(POST|PUT|PATCH|DELETE)|-d|--data\S*|-F|--form|-T|--upload-file|--json)(\s|=|$)/i.test(
          rest,
        )
      )
        kinds.add("net:send");
      else if (/(^|\s)(-o|-O|--output|--remote-name)(\s|$)/.test(rest))
        kinds.add(`${cmd} download`);
      continue;
    }
    if (cmd === "find" && !/\s-(delete|exec|execdir|ok)\b/.test(seg)) continue;
    if (cmd === "sed" && !/(^|\s)-i/.test(seg)) continue;
    if (READ_ONLY.has(cmd)) continue;
    if (MULTI.test(cmd)) {
      const sub = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
      const readRe = READ_SUBCOMMANDS[cmd];
      if (
        readRe &&
        (readRe.test(sub) || (cmd === "git" && sub === "stash" && argv.includes("list")))
      )
        continue;
      kinds.add(sub ? `${cmd} ${sub}` : cmd);
      continue;
    }
    kinds.add(cmd);
  }
  return [...kinds];
}

export function neverAutoReason(kind: string): string | null {
  for (const [re, reason] of NEVER_AUTO) if (re.test(kind)) return reason;
  return null;
}

export function isTrusted(kind: string, data = loadTrust()): boolean {
  if (neverAutoReason(kind)) return false;
  const rec = data.kinds[kind];
  if (!rec || rec.revoked) return false;
  return Boolean(rec.granted) || rec.streak >= TRUST_THRESHOLD;
}

export type TrustCheck = { allowed: true } | { allowed: false; kind: string; reason: string };

/** Whether FRIDAY may do this on her own right now. */
export function checkTrust(kinds: string[], stateDir?: string): TrustCheck {
  const data = loadTrust(stateDir);
  for (const kind of kinds) {
    if (isTrusted(kind, data)) continue;
    const never = neverAutoReason(kind);
    const rec = data.kinds[kind];
    const reason = never
      ? `\`${kind}\` ${never}, which always needs Sir's approval`
      : rec?.revoked
        ? `Sir revoked autonomous \`${kind}\``
        : `\`${kind}\` hasn't earned trust yet (${rec?.streak ?? 0}/${TRUST_THRESHOLD} clean runs)`;
    return { allowed: false, kind, reason };
  }
  return { allowed: true };
}

/** Autonomous = Sir isn't watching: heartbeat, a scheduled (cron) run, or a background job. */
export function isAutonomousRun(ctx: { messageProvider?: string; sessionKey?: string }): boolean {
  // Sub-agents started by an autonomous run carry an "auto-" marker in their session key.
  return (
    ctx.messageProvider === "heartbeat" ||
    /(^|:)cron:|:subagent:auto-|(^|:)job:/.test(ctx.sessionKey ?? "")
  );
}

export function recordOutcome(
  kinds: string[],
  ok: boolean,
  opts: { stateDir?: string; now?: Date } = {},
): void {
  if (!kinds.length) return;
  const at = (opts.now ?? new Date()).toISOString();
  const data = loadTrust(opts.stateDir);
  for (const kind of kinds) {
    const rec = (data.kinds[kind] ??= { ok: 0, fail: 0, streak: 0 });
    if (ok) {
      rec.ok++;
      rec.streak++;
      rec.lastOkAt = at;
    } else {
      rec.fail++;
      rec.streak = 0;
      rec.lastFailAt = at;
    }
  }
  saveTrust(data, opts.stateDir);
}

export function setGrant(kind: string, grant: boolean, stateDir?: string): KindRecord {
  const data = loadTrust(stateDir);
  const rec = (data.kinds[kind] ??= { ok: 0, fail: 0, streak: 0 });
  if (grant) {
    rec.granted = true;
    rec.revoked = false;
  } else {
    rec.granted = false;
    rec.revoked = true;
    rec.streak = 0;
  }
  saveTrust(data, stateDir);
  return rec;
}

// --- Action log, undo and the morning brief -----------------------------------------------

/** A best-effort command that reverses a shell action, when there is an obvious one. */
export function undoHint(command: string, output: string, cwd?: string): string | undefined {
  const argv = argvOf(segments(command)[0] ?? "");
  const cmd = argv[0];
  const args = argv.slice(1).filter((a) => !a.startsWith("-"));
  const [sub, ...target] = args;
  const user = argv.includes("--user") ? " --user" : "";
  if (cmd === "git" && sub === "commit") {
    const sha = /\[[^\]\s]+ ([0-9a-f]{7,40})\]/.exec(output)?.[1];
    return sha ? `git${cwd ? ` -C ${cwd}` : ""} revert ${sha}` : undefined;
  }
  if (cmd === "systemctl") {
    const flip: Record<string, string> = {
      start: "stop",
      stop: "start",
      enable: "disable",
      disable: "enable",
      mask: "unmask",
      unmask: "mask",
    };
    if (sub && flip[sub] && target.length)
      return `systemctl${user} ${flip[sub]} ${target.join(" ")}`;
  }
  if ((cmd === "pip" || cmd === "pip3") && sub === "install" && target.length)
    return `${cmd} uninstall -y ${target.join(" ")}`;
  if (
    (cmd === "npm" || cmd === "pnpm") &&
    (sub === "install" || sub === "add" || sub === "i") &&
    target.length
  ) {
    return `${cmd} remove ${target.join(" ")}`;
  }
  if (cmd === "mkdir" && args.length) return `rmdir ${args.join(" ")}`;
  if (cmd === "mv" && args.length === 2) return `mv ${args[1]} ${args[0]}`;
  return undefined;
}

export function newActionId(): string {
  return `a_${crypto.randomBytes(4).toString("hex")}`;
}

export function logAutonomousAction(action: AutonomousAction, stateDir?: string): void {
  const file = actionsFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(action)}\n`, { mode: 0o600 });
}

export function readAutonomousActions(
  opts: { sinceMs?: number; stateDir?: string } = {},
): AutonomousAction[] {
  try {
    return fs
      .readFileSync(actionsFile(opts.stateDir), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AutonomousAction)
      .filter((a) => !opts.sinceMs || Date.parse(a.at) >= opts.sinceMs);
  } catch {
    return [];
  }
}

/** Before an autonomous file change: keep the current content so it can be restored. */
export function snapshotFile(actionId: string, filePath: string, stateDir?: string): string {
  const dir = path.join(trustDir(stateDir), "undo", actionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(filePath);
  if (existed) fs.copyFileSync(filePath, path.join(dir, "content"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ path: filePath, existed }), {
    mode: 0o600,
  });
  return dir;
}

/** Restore a snapshotted file change. Returns what was done. */
export function undoAction(actionId: string, stateDir?: string): string {
  const action = readAutonomousActions({ stateDir }).find((a) => a.id === actionId);
  if (!action) throw new Error(`No autonomous action ${actionId}`);
  if (action.snapshot) {
    const meta = JSON.parse(fs.readFileSync(path.join(action.snapshot, "meta.json"), "utf-8")) as {
      path: string;
      existed: boolean;
    };
    if (meta.existed) fs.copyFileSync(path.join(action.snapshot, "content"), meta.path);
    else fs.rmSync(meta.path, { force: true });
    return meta.existed
      ? `Restored ${meta.path} to its previous content.`
      : `Removed ${meta.path} (it didn't exist before).`;
  }
  if (action.undo) return `No automatic undo for this one. To reverse it, run: ${action.undo}`;
  throw new Error(`Action ${actionId} has no undo information.`);
}

/** Morning brief: autonomous actions since the last brief, each with its undo. */
export function morningBrief(opts: { stateDir?: string; now?: Date } = {}): {
  text: string;
  count: number;
} {
  const now = opts.now ?? new Date();
  const data = loadTrust(opts.stateDir);
  const since = data.lastBriefAt ? Date.parse(data.lastBriefAt) : now.getTime() - 24 * 3600_000;
  const actions = readAutonomousActions({ sinceMs: since, stateDir: opts.stateDir });
  if (!actions.length) return { text: "", count: 0 };
  const lines = actions.map((a) => {
    const time = new Date(a.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const undo = a.snapshot
      ? ` (undo: friday trust undo ${a.id})`
      : a.undo
        ? ` (undo: ${a.undo})`
        : "";
    return `- ${time} ${a.ok ? "" : "FAILED: "}${a.what.slice(0, 120)}${undo}`;
  });
  return {
    text: `What I did on my own since ${new Date(since).toLocaleString("en-IN")}:\n${lines.join("\n")}`,
    count: actions.length,
  };
}

export function markBriefSent(opts: { stateDir?: string; now?: Date } = {}): void {
  const data = loadTrust(opts.stateDir);
  data.lastBriefAt = (opts.now ?? new Date()).toISOString();
  saveTrust(data, opts.stateDir);
}
