import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Process boundary for the worktree manager. Every git, test and lint invocation goes through a
 * `CommandRunner`: an executable plus an argument array, never a shell string, so branch names
 * and ids cannot be interpreted by a shell. Tests inject a fake.
 */

export type CommandRequest = {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
};

export type CommandResult = {
  /** Null when the process did not exit normally (timeout, signal, could not start). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started or was killed for another reason. */
  error?: string;
};

/** Must resolve (never reject) with a result describing every outcome. */
export type CommandRunner = (req: CommandRequest) => Promise<CommandResult>;

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Real runner on `node:child_process` `execFile` (no shell). */
export const execFileRunner: CommandRunner = (req) =>
  new Promise<CommandResult>((resolve) => {
    execFile(
      req.file,
      [...req.args],
      {
        cwd: req.cwd,
        timeout: req.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
        // Never block on a credential prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr, timedOut: false });
          return;
        }
        // `killed` with no error code is the timeout kill; string codes are spawn or buffer errors.
        const timedOut = err.killed === true && (code === undefined || code === null);
        resolve({
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          ...(timedOut ? {} : { error: err.message }),
        });
      },
    );
  });

/** Thrown when the manager (or a configured command) tries to run a git command it must never run. */
export class GitGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitGuardError";
  }
}

/** The only git subcommands the manager uses. `push` is deliberately absent (Req 9.9). */
const GIT_ALLOWED = new Set([
  "worktree",
  "rev-parse",
  "branch",
  "merge",
  "status",
  "add",
  "commit",
  "ls-files",
]);
const WORKTREE_ALLOWED = new Set(["add", "remove", "list"]);
/** Flags that would force, delete or rewrite something. Keeping every branch relies on this. */
const GIT_FORBIDDEN_FLAGS = new Set(["--force", "-f", "-F", "-d", "-D", "--delete", "--hard"]);

/**
 * Rejects any git command outside the manager's fixed vocabulary. Applies to every executable
 * named `git`, including a test or lint command configured by the caller.
 */
export function assertGitCommandAllowed(file: string, args: readonly string[]): void {
  if (path.basename(file) !== "git") {
    return;
  }
  const sub = args[0];
  if (sub === undefined || !GIT_ALLOWED.has(sub)) {
    throw new GitGuardError(`git ${sub ?? ""} is not allowed in the worktree manager`);
  }
  if (sub === "worktree" && !WORKTREE_ALLOWED.has(args[1] ?? "")) {
    throw new GitGuardError(`git worktree ${args[1] ?? ""} is not allowed`);
  }
  const forbidden = args.find((a) => GIT_FORBIDDEN_FLAGS.has(a));
  if (forbidden !== undefined) {
    throw new GitGuardError(`git flag ${forbidden} is not allowed in the worktree manager`);
  }
}
