// Chaos_Suite runner (Requirement 14.4-14.8). A scenario injects a fault into fakes (Proxy,
// Gateway, network, disk), then reports what the Job looked like and when. The runner judges the
// outcome, runs the registered restore steps, and checks that cleanup finished in time.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The Job must be done, or failed with a reason, this long after the fault (14.5). */
export const CHAOS_DEADLINE_MS = 300_000;
/** Restoring services and removing the temp location must take at most this long (14.8). */
export const CHAOS_CLEANUP_DEADLINE_MS = 60_000;
/** The disk-fill location never holds more than this (14.7). */
export const MAX_DISK_FILL_BYTES = 100 * 1024 * 1024;

export type ChaosFault = "proxy" | "gateway" | "network" | "disk";

/** What the scenario saw when it stopped watching the Job. Times are on the simulated clock. */
export type ChaosObservation = {
  faultInjectedAtMs: number;
  /** Last time the Job changed state, on the same clock as `faultInjectedAtMs`. */
  observedAtMs: number;
  state: string;
  failureReason?: string;
};

export type ChaosContext = {
  /** Registers a restore step. Steps run after the scenario, last registered first. */
  onCleanup(name: string, fn: () => void | Promise<void>): void;
};

export type ChaosScenario = {
  id: string;
  fault: ChaosFault;
  run(ctx: ChaosContext): Promise<ChaosObservation>;
  /** Returns what is not back to its pre-scenario state. Empty means everything is restored. */
  verifyRestored?(): string[] | Promise<string[]>;
};

export type ChaosScenarioResult = {
  id: string;
  fault: ChaosFault;
  pass: boolean;
  reasons: string[];
  /** The Job state the scenario observed, reported on failure (14.6). */
  observed?: { state: string; failureReason?: string; elapsedMs: number };
  cleanupMs: number;
  cleanupErrors: string[];
};

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** Judges a Job observation against 14.5 and 14.6. Returns the reasons it fails, if any. */
export function judgeChaosObservation(obs: ChaosObservation): string[] {
  const elapsed = obs.observedAtMs - obs.faultInjectedAtMs;
  const where = `Job state observed: ${obs.state}${
    obs.failureReason ? ` (reason: ${obs.failureReason})` : ""
  }, ${elapsed}ms after the fault`;
  if (!TERMINAL.has(obs.state)) return [`Job left in non-terminal state. ${where}`];
  const reasons: string[] = [];
  if (obs.state === "cancelled") reasons.push(`Job was cancelled, not done or failed. ${where}`);
  if (obs.state === "failed" && !obs.failureReason?.trim()) {
    reasons.push(`Job failed without a recorded reason. ${where}`);
  }
  if (elapsed > CHAOS_DEADLINE_MS) {
    reasons.push(`Job took longer than ${CHAOS_DEADLINE_MS}ms to finish. ${where}`);
  }
  return reasons;
}

export type ChaosSuiteOptions = {
  /** Clock used to time cleanup. Defaults to `Date.now`. */
  now?: () => number;
};

export async function runChaosScenario(
  scenario: ChaosScenario,
  opts: ChaosSuiteOptions = {},
): Promise<ChaosScenarioResult> {
  const now = opts.now ?? Date.now;
  const cleanups: Array<{ name: string; fn: () => void | Promise<void> }> = [];
  const reasons: string[] = [];
  let observed: ChaosScenarioResult["observed"];

  try {
    const obs = await scenario.run({ onCleanup: (name, fn) => cleanups.push({ name, fn }) });
    observed = {
      state: obs.state,
      ...(obs.failureReason !== undefined ? { failureReason: obs.failureReason } : {}),
      elapsedMs: obs.observedAtMs - obs.faultInjectedAtMs,
    };
    reasons.push(...judgeChaosObservation(obs));
  } catch (e) {
    reasons.push(`scenario threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Restore everything even when the scenario failed or threw.
  const cleanupErrors: string[] = [];
  const cleanupStart = now();
  for (const c of cleanups.reverse()) {
    try {
      await c.fn();
    } catch (e) {
      cleanupErrors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const cleanupMs = now() - cleanupStart;
  if (cleanupErrors.length > 0) reasons.push(`cleanup failed: ${cleanupErrors.join("; ")}`);
  if (cleanupMs > CHAOS_CLEANUP_DEADLINE_MS) {
    reasons.push(`restore took ${cleanupMs}ms, over the ${CHAOS_CLEANUP_DEADLINE_MS}ms limit`);
  }
  try {
    const notRestored = (await scenario.verifyRestored?.()) ?? [];
    if (notRestored.length > 0) reasons.push(`not restored: ${notRestored.join(", ")}`);
  } catch (e) {
    reasons.push(`restore check threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    id: scenario.id,
    fault: scenario.fault,
    pass: reasons.length === 0,
    reasons,
    ...(observed ? { observed } : {}),
    cleanupMs,
    cleanupErrors,
  };
}

export async function runChaosSuite(
  scenarios: readonly ChaosScenario[],
  opts: ChaosSuiteOptions = {},
): Promise<ChaosScenarioResult[]> {
  const out: ChaosScenarioResult[] = [];
  for (const s of scenarios) out.push(await runChaosScenario(s, opts));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Size-limited temp location for the disk-fill fault (14.7)
// ---------------------------------------------------------------------------------------------

/**
 * A fresh directory under `parentDir` (default: the OS temp dir) that the suite may fill up to
 * `capBytes`. Only files created through this object are ever deleted; `remove()` leaves the
 * directory in place, and says so, if anything else ended up inside it.
 */
export class TempDiskArea {
  private readonly created = new Set<string>();
  private used = 0;
  private removed = false;
  private seq = 0;

  private constructor(
    readonly dir: string,
    readonly capBytes: number,
  ) {}

  static async create(
    capBytes: number,
    parentDir: string = os.tmpdir(),
  ): Promise<TempDiskArea> {
    if (!Number.isInteger(capBytes) || capBytes <= 0 || capBytes > MAX_DISK_FILL_BYTES) {
      throw new Error(`disk cap must be an integer from 1 to ${MAX_DISK_FILL_BYTES} bytes`);
    }
    const dir = await fs.mkdtemp(path.join(parentDir, "friday-chaos-"));
    return new TempDiskArea(await fs.realpath(dir), capBytes);
  }

  get usedBytes(): number {
    return this.used;
  }

  /** Free bytes in the area, as the fake disk probe reports them. */
  freeBytes(): number {
    return this.capBytes - this.used;
  }

  /** Writes filler files until the area is full. Never writes past the cap. */
  async fill(chunkBytes = 64 * 1024): Promise<void> {
    if (this.removed) throw new Error("temp location already removed");
    while (this.used < this.capBytes) {
      const size = Math.min(chunkBytes, this.capBytes - this.used);
      const file = path.join(this.dir, `fill-${this.seq++}.bin`);
      await fs.writeFile(file, Buffer.alloc(size, 0x46), { flag: "wx" });
      this.created.add(file);
      this.used += size;
    }
  }

  /** Deletes the files this object created, then the (then empty) directory. */
  async remove(): Promise<void> {
    if (this.removed) return;
    for (const file of this.created) {
      // Defence in depth: never touch anything outside the area.
      if (path.dirname(file) !== this.dir) throw new Error(`refusing to delete ${file}`);
      await fs.unlink(file);
      this.created.delete(file);
    }
    this.used = 0;
    // rmdir fails on a non-empty directory, so foreign files are never removed.
    await fs.rmdir(this.dir);
    this.removed = true;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.dir);
      return true;
    } catch {
      return false;
    }
  }
}
