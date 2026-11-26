import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SandboxExecutionResult } from "./types.js";

export interface SandboxRunOptions {
  code: string;
  testCode: string;
  scratchDir: string;
  timeoutMs?: number;
}

export async function runInSandbox(options: SandboxRunOptions): Promise<SandboxExecutionResult> {
  const timeoutMs = options.timeoutMs ?? 20000;
  const scratchDir = options.scratchDir;

  await fs.mkdir(scratchDir, { recursive: true });

  const solutionPath = path.join(scratchDir, "solution.py");
  const testPath = path.join(scratchDir, "test_solution.py");

  await fs.writeFile(solutionPath, options.code, "utf-8");
  await fs.writeFile(testPath, options.testCode, "utf-8");

  const startTime = Date.now();

  // Bubblewrap invocation command
  const bwrapArgs = [
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--tmpfs",
    "/tmp",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--bind",
    scratchDir,
    "/tmp/scratch",
    "--chdir",
    "/tmp/scratch",
    "python3",
    "-m",
    "pytest",
    "test_solution.py",
    "-v",
  ];

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("bwrap", bwrapArgs, {
        cwd: scratchDir,
        env: {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          HOME: "/tmp/scratch",
          PYTHONPATH: "/tmp/scratch",
        },
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: String(err),
        passed: false,
        durationMs: Date.now() - startTime,
        errorReason: `Failed to spawn sandbox: ${String(err)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + "\nExecution timed out in sandbox",
          passed: false,
          durationMs,
          errorReason: `Execution timed out after ${timeoutMs}ms`,
        });
        return;
      }

      const passed = code === 0 && (stdout.includes("passed") || stdout.includes("1 passed"));
      let errorReason: string | undefined;
      if (!passed) {
        errorReason = stderr.trim() || stdout.trim() || `Process exited with code ${code}`;
      }

      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        passed,
        durationMs,
        errorReason,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: String(err),
        passed: false,
        durationMs: Date.now() - startTime,
        errorReason: `Sandbox process error: ${String(err)}`,
      });
    });
  });
}
