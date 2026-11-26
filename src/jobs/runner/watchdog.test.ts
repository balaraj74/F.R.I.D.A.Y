import { describe, expect, it } from "vitest";
import { FakeClock } from "./test-helpers.js";
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  resolveStallTimeoutSeconds,
  startWatchdog,
} from "./watchdog.js";

describe("resolveStallTimeoutSeconds", () => {
  it("defaults to 120 for missing or invalid values", () => {
    expect(DEFAULT_STALL_TIMEOUT_SECONDS).toBe(120);
    for (const v of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(resolveStallTimeoutSeconds(v)).toBe(120);
    }
    expect(resolveStallTimeoutSeconds(30)).toBe(30);
  });
});

describe("startWatchdog", () => {
  it("fires once after the stall timeout with no output", async () => {
    const clock = new FakeClock();
    const idle: number[] = [];
    startWatchdog({ clock, stallTimeoutMs: 1000, onStall: (ms) => idle.push(ms) });
    await clock.advance(999);
    expect(idle).toEqual([]);
    await clock.advance(5000);
    expect(idle).toEqual([1000]);
  });

  it("restarts the timer on each touch", async () => {
    const clock = new FakeClock();
    const idle: number[] = [];
    const dog = startWatchdog({ clock, stallTimeoutMs: 1000, onStall: (ms) => idle.push(ms) });
    for (let i = 0; i < 5; i++) {
      await clock.advance(900);
      dog.touch();
    }
    expect(idle).toEqual([]);
    await clock.advance(1000);
    expect(idle).toEqual([1000]);
  });

  it("does not fire after stop", async () => {
    const clock = new FakeClock();
    let fired = false;
    const dog = startWatchdog({ clock, stallTimeoutMs: 1000, onStall: () => (fired = true) });
    dog.stop();
    await clock.advance(10_000);
    expect(fired).toBe(false);
  });
});
