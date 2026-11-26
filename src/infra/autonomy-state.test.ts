import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FRIDAYConfig } from "../config/config.js";
import { isAutonomyPaused, readAutonomyState, setAutonomyPaused } from "./autonomy-state.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

describe("autonomy kill switch", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-autonomy-"));
    previous = process.env.FRIDAY_STATE_DIR;
    process.env.FRIDAY_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.FRIDAY_STATE_DIR;
    else process.env.FRIDAY_STATE_DIR = previous;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("defaults to active and round-trips pause/resume", () => {
    expect(isAutonomyPaused()).toBe(false);
    setAutonomyPaused(true, "travelling");
    expect(readAutonomyState()).toMatchObject({ paused: true, reason: "travelling" });
    setAutonomyPaused(false);
    expect(isAutonomyPaused()).toBe(false);
  });

  it("stops the heartbeat loop while paused", async () => {
    const cfg: FRIDAYConfig = {
      agents: { defaults: { userTimezone: "UTC", heartbeat: { every: "30m" } } },
    };
    setAutonomyPaused(true);
    const res = await runHeartbeatOnce({
      cfg,
      deps: { nowMs: () => Date.UTC(2026, 9, 22, 12, 0, 0) },
    });
    expect(res).toEqual({ status: "skipped", reason: "autonomy-paused" });
  });
});
