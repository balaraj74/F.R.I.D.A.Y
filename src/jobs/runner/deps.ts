// Injectable boundaries for the Step_Runner and Watchdog: clock, sleep and file system.
// Production code uses the defaults here; tests pass fakes (see test-helpers.ts).
import fs from "node:fs/promises";
import path from "node:path";

/** Time source plus a cancellable timer. One object so a fake clock can drive both. */
export interface RunnerClock {
  now(): number;
  /** Runs `fn` after `ms` milliseconds. Returns a function that cancels the timer. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: RunnerClock = {
  now: () => Date.now(),
  setTimer(fn, ms) {
    // Timers must not keep the process alive on their own; the Job_Engine owns lifetime.
    const handle = setTimeout(fn, Math.min(Math.max(ms, 0), 2 ** 31 - 1));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

export type Sleep = (ms: number) => Promise<void>;

/** Default sleep, built on the clock's timer so a fake clock controls it too. */
export function sleepWithClock(clock: RunnerClock): Sleep {
  return (ms) => new Promise<void>((resolve) => clock.setTimer(resolve, ms));
}

/** The two file operations the runner needs for progress.md. */
export interface RunnerFs {
  /** Returns the file text, or null when the file does not exist. */
  readText(filePath: string): Promise<string | null>;
  /** Replaces the file. Must not leave a partly written file behind. */
  writeText(filePath: string, text: string): Promise<void>;
}

export const nodeRunnerFs: RunnerFs = {
  async readText(filePath) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  async writeText(filePath, text) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Temp file then rename, so a crash cannot leave a truncated progress.md.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, filePath);
  },
};
