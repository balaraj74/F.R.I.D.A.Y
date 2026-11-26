import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAOS_CLEANUP_DEADLINE_MS,
  CHAOS_DEADLINE_MS,
  MAX_DISK_FILL_BYTES,
  TempDiskArea,
  judgeChaosObservation,
  runChaosScenario,
  runChaosSuite,
  type ChaosScenario,
} from "../../src/jobs/evals/chaos.js";
import { createChaosScenarios } from "./scenarios.js";

// Everything the suite creates lives under this per-test temp dir, which the test removes itself.
let sandbox: string;
beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "friday-chaos-test-"));
});
afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("Chaos_Suite scenarios (fakes only)", () => {
  it("has proxy, gateway, network and disk scenarios", () => {
    expect(
      createChaosScenarios()
        .map((s) => s.fault)
        .sort(),
    ).toEqual(["disk", "gateway", "network", "proxy"]);
  });

  it("every fault ends with the Job done or failed with a reason, and everything restored", async () => {
    const results = await runChaosSuite(createChaosScenarios({ diskCapBytes: 64 * 1024, tmpParent: sandbox }));
    for (const r of results) {
      expect(r.reasons, r.id).toEqual([]);
      expect(r.pass, r.id).toBe(true);
      expect(["done", "failed"]).toContain(r.observed?.state);
      expect(r.observed?.elapsedMs).toBeLessThanOrEqual(CHAOS_DEADLINE_MS);
      expect(r.cleanupMs).toBeLessThanOrEqual(CHAOS_CLEANUP_DEADLINE_MS);
    }
    // The disk-fill temp location is gone and nothing else was left in the sandbox.
    expect(await fs.readdir(sandbox)).toEqual([]);
  });

  it("the single-fault scenarios recover to done", async () => {
    const results = await runChaosSuite(createChaosScenarios({ diskCapBytes: 64 * 1024, tmpParent: sandbox }));
    expect(results.map((r) => [r.id, r.observed?.state])).toEqual([
      ["kill-proxy", "done"],
      ["kill-gateway", "done"],
      ["cut-network", "done"],
      ["fill-disk", "done"],
    ]);
  });
});

describe("chaos judgement", () => {
  const base = { faultInjectedAtMs: 1_000 };
  it("accepts done and failed-with-reason inside 300s", () => {
    expect(judgeChaosObservation({ ...base, observedAtMs: 2_000, state: "done" })).toEqual([]);
    expect(
      judgeChaosObservation({ ...base, observedAtMs: 2_000, state: "failed", failureReason: "disk full" }),
    ).toEqual([]);
  });
  it("fails a non-terminal Job and reports the state", () => {
    const [reason] = judgeChaosObservation({ ...base, observedAtMs: 301_000, state: "running" });
    expect(reason).toContain("non-terminal");
    expect(reason).toContain("running");
  });
  it("fails a failed Job with no recorded reason", () => {
    const reasons = judgeChaosObservation({ ...base, observedAtMs: 2_000, state: "failed" });
    expect(reasons.join()).toContain("without a recorded reason");
  });
  it("fails a Job that finishes after 300s", () => {
    const reasons = judgeChaosObservation({
      ...base,
      observedAtMs: 1_000 + CHAOS_DEADLINE_MS + 1,
      state: "done",
    });
    expect(reasons.join()).toContain("longer than");
  });
  it("marks a scenario failed with the observed state, still runs cleanups, and flags slow restore", async () => {
    let restored = false;
    let t = 0;
    const stuck: ChaosScenario = {
      id: "stuck",
      fault: "proxy",
      run: async (ctx) => {
        ctx.onCleanup("restore", () => {
          restored = true;
          t += CHAOS_CLEANUP_DEADLINE_MS + 1;
        });
        return { faultInjectedAtMs: 0, observedAtMs: 10, state: "paused" };
      },
      verifyRestored: () => ["proxy still down"],
    };
    const r = await runChaosScenario(stuck, { now: () => t });
    expect(r.pass).toBe(false);
    expect(restored).toBe(true);
    expect(r.observed?.state).toBe("paused");
    const text = r.reasons.join("\n");
    expect(text).toContain("non-terminal state. Job state observed: paused");
    expect(text).toContain("restore took");
    expect(text).toContain("not restored: proxy still down");
  });
  it("records a throwing scenario as failed and still restores", async () => {
    let restored = false;
    const r = await runChaosScenario({
      id: "throws",
      fault: "gateway",
      run: async (ctx) => {
        ctx.onCleanup("restore", () => {
          restored = true;
        });
        throw new Error("harness broke");
      },
    });
    expect(r.pass).toBe(false);
    expect(restored).toBe(true);
    expect(r.reasons[0]).toContain("harness broke");
  });
});

describe("TempDiskArea", () => {
  it("refuses a cap above 100 MB or below 1 byte", async () => {
    await expect(TempDiskArea.create(MAX_DISK_FILL_BYTES + 1, sandbox)).rejects.toThrow();
    await expect(TempDiskArea.create(0, sandbox)).rejects.toThrow();
  });
  it("never writes past the cap and removes only its own files", async () => {
    const area = await TempDiskArea.create(10_000, sandbox);
    await area.fill(3_000);
    expect(area.usedBytes).toBe(10_000);
    expect(area.freeBytes()).toBe(0);
    const written = (await fs.readdir(area.dir)).length;
    expect(written).toBe(4);
    // A file the suite did not create must survive, and so must its directory.
    const foreign = path.join(area.dir, "keep.txt");
    await fs.writeFile(foreign, "mine");
    await expect(area.remove()).rejects.toThrow();
    expect(await fs.readFile(foreign, "utf8")).toBe("mine");
    expect(await fs.readdir(area.dir)).toEqual(["keep.txt"]);
    // The test owns the sandbox, so it clears the foreign file itself.
    await fs.unlink(foreign);
    await area.remove();
    expect(await area.exists()).toBe(false);
  });
});
