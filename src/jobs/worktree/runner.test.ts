import { describe, expect, it } from "vitest";

import { assertGitCommandAllowed, execFileRunner, GitGuardError } from "./runner.js";

describe("assertGitCommandAllowed", () => {
  it("allows the manager's git vocabulary", () => {
    expect(() =>
      assertGitCommandAllowed("git", ["worktree", "add", "-b", "b", "/p", "s"]),
    ).not.toThrow();
    expect(() =>
      assertGitCommandAllowed("git", ["merge", "--no-ff", "--no-edit", "b"]),
    ).not.toThrow();
    expect(() => assertGitCommandAllowed("git", ["worktree", "remove", "/p"])).not.toThrow();
  });

  it.each([
    ["push", ["push", "origin", "main"]],
    ["push with options", ["push", "--force"]],
    ["reset", ["reset", "--hard"]],
    ["branch delete", ["branch", "-D", "x"]],
    ["forced worktree remove", ["worktree", "remove", "--force", "/p"]],
    ["worktree prune", ["worktree", "prune"]],
    ["no subcommand", []],
  ])("rejects %s", (_name, args) => {
    expect(() => assertGitCommandAllowed("git", args)).toThrow(GitGuardError);
  });

  it("applies to an absolute git path and ignores other executables", () => {
    expect(() => assertGitCommandAllowed("/usr/bin/git", ["push"])).toThrow(GitGuardError);
    expect(() => assertGitCommandAllowed("pnpm", ["push"])).not.toThrow();
  });
});

describe("execFileRunner", () => {
  const node = process.execPath;

  it("returns output and exit code without a shell", async () => {
    const ok = await execFileRunner({
      file: node,
      args: ["-e", "process.stdout.write(process.argv[1])", "a b; $(echo hi)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "a b; $(echo hi)", timedOut: false });
    const bad = await execFileRunner({
      file: node,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(bad).toMatchObject({ exitCode: 3, timedOut: false });
  });

  it("reports a timeout and a missing executable instead of throwing", async () => {
    const slow = await execFileRunner({
      file: node,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(slow).toMatchObject({ exitCode: null, timedOut: true });
    const missing = await execFileRunner({
      file: "friday-no-such-binary",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(missing.exitCode).toBeNull();
    expect(missing.error).toBeTruthy();
  });
});
