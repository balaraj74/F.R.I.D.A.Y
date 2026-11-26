// Coding partner: FRIDAY works on Sir's projects in a separate git worktree on her own branch
// (friday/<task>), inside her workspace. His checkout, current branch and uncommitted changes
// are never touched; nothing reaches his branches until he says merge.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CodeTask = {
  id: string;
  repo: string;
  branch: string;
  base: string;
  dir: string;
  task: string;
  createdAt: string;
};

const MAX_OUTPUT = 12_000;

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

const tasksFile = (workspaceDir: string) => path.join(workspaceDir, "code", "tasks.json");

export function listTasks(workspaceDir: string): CodeTask[] {
  try {
    return JSON.parse(fs.readFileSync(tasksFile(workspaceDir), "utf-8")) as CodeTask[];
  } catch {
    return [];
  }
}

function saveTasks(workspaceDir: string, tasks: CodeTask[]) {
  fs.mkdirSync(path.dirname(tasksFile(workspaceDir)), { recursive: true });
  fs.writeFileSync(tasksFile(workspaceDir), JSON.stringify(tasks, null, 2));
}

export function getTask(workspaceDir: string, id: string): CodeTask {
  const task = listTasks(workspaceDir).find((t) => t.id === id);
  if (!task) throw new Error(`No coding task ${id}. Use list to see them.`);
  return task;
}

export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";

/** New branch + worktree from the repo's current HEAD. */
export async function startTask(params: {
  workspaceDir: string;
  repo: string;
  task: string;
}): Promise<CodeTask> {
  const repo = await git(path.resolve(params.repo.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")), [
    "rev-parse",
    "--show-toplevel",
  ]).catch(() => {
    throw new Error(`${params.repo} isn't a git repository.`);
  });
  const base = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = slug(params.task);
  const existing = new Set(listTasks(params.workspaceDir).map((t) => t.id));
  let id = `${path.basename(repo)}-${name}`;
  for (let n = 2; existing.has(id); n++) id = `${path.basename(repo)}-${name}-${n}`;
  const branch = `friday/${id.slice(path.basename(repo).length + 1)}`;
  const dir = path.join(params.workspaceDir, "code", id);
  await git(repo, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  linkDependencies(repo, dir);
  const task: CodeTask = {
    id,
    repo,
    branch,
    base,
    dir,
    task: params.task,
    createdAt: new Date().toISOString(),
  };
  saveTasks(params.workspaceDir, [...listTasks(params.workspaceDir), task]);
  return task;
}

/** Reuse the main checkout's installed dependencies so tests run without a fresh install. */
function linkDependencies(repo: string, dir: string) {
  for (const deps of ["node_modules", ".venv", "venv"]) {
    const src = path.join(repo, deps);
    const dest = path.join(dir, deps);
    if (fs.existsSync(src) && !fs.existsSync(dest)) fs.symlinkSync(src, dest, "dir");
  }
}

/** The project's test command, by what the repo contains. */
export function detectTestCommand(dir: string): string[] | null {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      const pm = has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : has("bun.lockb")
            ? "bun"
            : "npm";
      return [pm, "test"];
    }
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tests")) {
    const venvPython = [".venv/bin/python", "venv/bin/python"]
      .map((p) => path.join(dir, p))
      .find((p) => fs.existsSync(p));
    return [venvPython ?? "python3", "-m", "pytest", "-q"];
  }
  if (has("Cargo.toml")) return ["cargo", "test"];
  if (has("go.mod")) return ["go", "test", "./..."];
  if (has("Makefile") && /^test:/m.test(fs.readFileSync(path.join(dir, "Makefile"), "utf-8")))
    return ["make", "test"];
  return null;
}

export async function runTests(
  task: CodeTask,
  command?: string,
): Promise<{ command: string; passed: boolean; output: string }> {
  const argv = command ? ["bash", "-lc", command] : detectTestCommand(task.dir);
  if (!argv) throw new Error("I couldn't tell how this project runs its tests; pass the command.");
  const shown = command ?? argv.join(" ");
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), {
      cwd: task.dir,
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    return { command: shown, passed: true, output: tail(`${stdout}\n${stderr}`) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      command: shown,
      passed: false,
      output: tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`),
    };
  }
}

const tail = (s: string) => {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return clean.length > MAX_OUTPUT ? `…${clean.slice(-MAX_OUTPUT)}` : clean;
};

/** Commit whatever changed in the worktree and show it against the starting point. */
export async function reviewTask(
  task: CodeTask,
  message?: string,
): Promise<{ stat: string; diff: string; commits: string }> {
  await git(task.dir, ["add", "-A", "--", ".", ":!node_modules", ":!.venv", ":!venv", ":!.serena"]);
  const staged = await git(task.dir, ["diff", "--cached", "--name-only"]);
  if (staged) {
    await git(task.dir, [
      "-c",
      "user.name=FRIDAY",
      "-c",
      "user.email=friday@localhost",
      "commit",
      "-q",
      "-m",
      message?.trim() || `FRIDAY: ${task.task}`.slice(0, 72),
    ]);
  }
  const range = `${task.base}...${task.branch}`;
  return {
    stat: await git(task.dir, ["diff", "--stat", range]),
    diff: tail(await git(task.dir, ["diff", range])),
    commits: await git(task.dir, ["log", "--oneline", `${task.base}..${task.branch}`]),
  };
}

/** Merge her branch into the branch it started from, in Sir's checkout. Only when he asks. */
export async function mergeTask(workspaceDir: string, task: CodeTask): Promise<string> {
  await reviewTask(task);
  const current = await git(task.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== task.base) {
    throw new Error(
      `Sir's checkout is on ${current}, not ${task.base}; switch back to ${task.base} first.`,
    );
  }
  if (await git(task.repo, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error(
      `${task.repo} has uncommitted changes; commit or stash them first, then merge.`,
    );
  }
  const out = await git(task.repo, ["merge", "--no-ff", "--no-edit", task.branch]).catch((err) => {
    void git(task.repo, ["merge", "--abort"]).catch(() => {});
    throw new Error(`Merge conflict, nothing changed: ${String(err).slice(0, 300)}`);
  });
  await removeTask(workspaceDir, task, false);
  return out;
}

/** Drop the worktree (and the branch unless it was merged and should stay in history). */
export async function removeTask(workspaceDir: string, task: CodeTask, deleteBranch = true) {
  await git(task.repo, ["worktree", "remove", "--force", task.dir]).catch(() => {});
  if (deleteBranch) await git(task.repo, ["branch", "-D", task.branch]).catch(() => {});
  saveTasks(
    workspaceDir,
    listTasks(workspaceDir).filter((t) => t.id !== task.id),
  );
}
