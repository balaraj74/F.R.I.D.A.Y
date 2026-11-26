// Autonomy policy for shell commands (ROADMAP_V2 A3). FRIDAY runs most commands on her own;
// commands in the "hard-never" categories always need Sir's explicit approval, even when exec
// security is "full", asks are off, or elevated mode would normally bypass approvals.
// This is enforced in code (bash-tools.exec), not just described in the prompt.

export type RiskCategory =
  | "delete-data"
  | "force-push"
  | "system-settings"
  | "credentials"
  | "money"
  | "remote-code"
  | "unearned-trust";

export type ExecRisk =
  | { requiresApproval: false }
  | { requiresApproval: true; category: RiskCategory; reason: string };

// Deleting these is routine and recoverable (rebuildable output, caches, temp files).
const SAFE_DELETE_TARGET =
  /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|coverage|target|\.parcel-cache)(\/|$)|^\/tmp\/|^\/var\/tmp\/|\.(pyc|o|log|tmp)$/;

/** Split a shell line into command segments on ; && || | and newlines (good enough for policy). */
function segments(command: string): string[] {
  return command
    .replace(/\$\(([^)]*)\)/g, " ; $1 ; ") // inspect command substitutions too
    .replace(/`([^`]*)`/g, " ; $1 ; ")
    .split(/\|\||&&|[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function words(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, "")) ?? [];
}

/** Command name after stripping env assignments and wrappers like sudo/nice/time. */
function commandWords(segment: string): { privileged: boolean; argv: string[] } {
  const argv = words(segment);
  let privileged = false;
  while (argv.length > 0) {
    const w = argv[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) argv.shift();
    else if (/^(sudo|doas|pkexec|su)$/.test(w)) {
      privileged = true;
      argv.shift();
      while (argv[0]?.startsWith("-")) argv.shift();
    } else if (/^(nice|time|nohup|command|exec|env)$/.test(w)) argv.shift();
    else break;
  }
  return { privileged, argv };
}

const need = (category: RiskCategory, reason: string): ExecRisk => ({
  requiresApproval: true,
  category,
  reason,
});

const CREDENTIAL_PATH =
  /(^|[\s"'=/])(~|\$HOME|\/home\/[^/\s]+)?\/?\.ssh\/|id_(rsa|ed25519|ecdsa)\b|\.friday\/credentials|(^|[\s/"'])\.env(\.[\w-]+)?(\s|$|["'])|\.aws\/credentials|\.netrc\b|\.git-credentials|\.npmrc\b|\.pypirc\b/;
const SECURITY_GSETTINGS =
  /org\.gnome\.desktop\.(lockdown|screensaver|privacy|remote-desktop)|org\.gnome\.settings-daemon\.plugins\.sharing/;

export function classifyExecRisk(command: string): ExecRisk {
  const raw = command.trim();
  if (!raw) return { requiresApproval: false };

  // Fetch-and-execute: running whatever a URL returns.
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|fi)?sh\b/.test(raw)) {
    return need("remote-code", "pipes a download straight into a shell");
  }
  if (
    CREDENTIAL_PATH.test(raw) ||
    /\bsecret-tool\s+lookup\b|\bgh\s+auth\s+token\b|--export-secret|\baws\s+configure\s+get\b/.test(
      raw,
    )
  ) {
    return need("credentials", "touches credentials or secret files");
  }
  if (
    /\b(stripe|razorpay|paypal)\b|\b(sendtoaddress|sendmany)\b|\bsolana\s+transfer\b|\bcast\s+send\b/.test(
      raw,
    )
  ) {
    return need("money", "payment or wallet command");
  }
  if (
    /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(;|$))/i.test(raw)
  ) {
    return need("delete-data", "destructive SQL");
  }

  for (const segment of segments(raw)) {
    const { privileged, argv } = commandWords(segment);
    const [cmd, ...args] = argv;
    if (!cmd) continue;
    const base = cmd.split("/").pop()!;
    if (privileged) return need("system-settings", `runs ${base} with elevated privileges`);

    switch (base) {
      case "rm":
      case "rmdir":
      case "unlink": {
        const targets = args.filter((a) => !a.startsWith("-"));
        if (targets.length === 0 || targets.some((t) => !SAFE_DELETE_TARGET.test(t))) {
          return need("delete-data", `deletes ${targets.join(" ") || "files"}`);
        }
        break;
      }
      case "shred":
      case "wipefs":
        return need("delete-data", `${base} destroys data`);
      case "dd":
        if (args.some((a) => /^of=\/dev\//.test(a)))
          return need("delete-data", "writes to a raw device");
        break;
      case "truncate":
        return need("delete-data", "truncates a file");
      case "find":
        if (
          args.includes("-delete") ||
          (args.includes("-exec") && args.some((a) => /^(rm|shred)$/.test(a)))
        ) {
          return need("delete-data", "find with delete");
        }
        break;
      case "git": {
        const sub = args.find((a) => !a.startsWith("-"));
        if (
          sub === "push" &&
          args.some(
            (a) =>
              /^(-f|--force|--force-with-lease(=.*)?|--mirror|--delete|-d)$/.test(a) ||
              /^\+/.test(a) ||
              /^:/.test(a),
          )
        ) {
          return need("force-push", "force-push or remote branch deletion");
        }
        if (sub === "clean" && args.some((a) => /^-\w*f/.test(a) || a === "--force"))
          return need("delete-data", "git clean removes untracked files");
        if (sub === "reset" && args.includes("--hard"))
          return need("delete-data", "git reset --hard discards changes");
        if (sub === "checkout" && args.includes("--") && args.includes("."))
          return need("delete-data", "discards working-tree changes");
        if (sub === "branch" && args.some((a) => a === "-D"))
          return need("delete-data", "force-deletes a branch");
        if (sub === "stash" && args.some((a) => a === "drop" || a === "clear"))
          return need("delete-data", "drops stashed work");
        break;
      }
      case "docker":
      case "podman":
        if (
          args.some((a) => /^(rm|rmi|prune)$/.test(a)) ||
          (args.includes("volume") && args.includes("rm"))
        ) {
          return need("delete-data", `${base} removes containers, images or volumes`);
        }
        break;
      case "dropdb":
      case "mkfs":
        return need("delete-data", `${base} destroys a database or filesystem`);
      case "systemctl":
        if (
          args.some((a) =>
            /^(start|stop|restart|reload|enable|disable|mask|unmask|kill|isolate|set-property|edit)$/.test(
              a,
            ),
          )
        ) {
          return need("system-settings", "changes system services");
        }
        break;
      case "ufw":
      case "iptables":
      case "nft":
      case "passwd":
      case "chpasswd":
      case "usermod":
      case "useradd":
      case "userdel":
      case "visudo":
      case "update-alternatives":
        return need("system-settings", `${base} changes system or security settings`);
      case "crontab":
        if (args.some((a) => a === "-r" || a === "-e" || (!a.startsWith("-") && a !== "-l"))) {
          return need("system-settings", "replaces the crontab");
        }
        break;
      case "gsettings":
        if (args[0] === "set" && SECURITY_GSETTINGS.test(args.join(" "))) {
          return need("system-settings", "changes desktop security/privacy settings");
        }
        break;
      case "chmod":
      case "chown":
      case "tee":
      case "cp":
      case "mv":
      case "install":
        if (args.some((a) => /^\/(etc|usr|boot|var\/lib|lib|bin|sbin)(\/|$)/.test(a))) {
          return need("system-settings", `${base} modifies system files`);
        }
        break;
    }
  }

  // Output redirection into system locations.
  if (/>\s*\/(etc|usr|boot|lib|bin|sbin)\//.test(raw)) {
    return need("system-settings", "writes into system files");
  }
  return { requiresApproval: false };
}
