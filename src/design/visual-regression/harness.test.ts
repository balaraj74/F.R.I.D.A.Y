import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { SCREENS, WINDOW_SIZES } from "./config.js";
import {
  captureFileName,
  runVisualRegression,
  type HarnessDeps,
  type HarnessOptions,
  type PixelDiffFn,
} from "./harness.js";

const BASELINES = "/b";
const DIFFS = "/d";

function setup(opts: {
  baselines?: Record<string, string>;
  diff?: PixelDiffFn;
  capture?: HarnessDeps["capture"];
}) {
  const files = new Map<string, Buffer>();
  for (const [name, content] of Object.entries(opts.baselines ?? {})) {
    files.set(path.join(BASELINES, name), Buffer.from(content));
  }
  const urls: string[] = [];
  const writes: string[] = [];
  const deps: HarnessDeps = {
    capture:
      opts.capture ??
      (async (req) => {
        urls.push(req.url);
        return Buffer.from(`${req.screen.name}-${req.size.name}`);
      }),
    // Fake diff: differing bytes count as differing pixels.
    diff:
      opts.diff ??
      (async (a, b) => {
        const diffPixels = a.equals(b) ? 0 : 5;
        return diffPixels ? { diffPixels, diffImage: Buffer.from("diff") } : { diffPixels };
      }),
    readFile: async (p) => files.get(p),
    writeFile: async (p, data) => {
      writes.push(p);
      files.set(p, data);
    },
  };
  return { deps, files, urls, writes };
}

function allBaselines(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of SCREENS) {
    for (const z of WINDOW_SIZES) {
      out[captureFileName(s.name, z.name)] = `${s.name}-${z.name}`;
    }
  }
  return out;
}

const options: HarnessOptions = {
  baseUrl: "http://hud.test/",
  baselineDir: BASELINES,
  diffDir: DIFFS,
  aaTolerancePixels: 0,
  channelThreshold: 0,
};

describe("runVisualRegression", () => {
  it("captures every screen at 3 window sizes and exits 0 when all match", async () => {
    const { deps, urls, writes } = setup({ baselines: allBaselines() });
    const report = await runVisualRegression(options, deps);
    expect(WINDOW_SIZES).toHaveLength(3);
    expect(report.results).toHaveLength(SCREENS.length * 3);
    expect(report.results.every((r) => r.status === "pass")).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(writes).toEqual([]);
    expect(urls[0]).toBe("http://hud.test/?screen=home");
  });

  it("fails with a diff image when pixels differ beyond the tolerance", async () => {
    const baselines = allBaselines();
    baselines[captureFileName("chat", "medium")] = "changed";
    const { deps, files } = setup({ baselines });
    const report = await runVisualRegression(options, deps);
    expect(report.exitCode).toBe(1);
    const failed = report.results.filter((r) => r.status !== "pass");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      screen: "chat",
      size: "medium",
      status: "fail-diff",
      diffPixels: 5,
      diffPath: path.join(DIFFS, "chat-medium.diff.png"),
    });
    expect(files.has(path.join(DIFFS, "chat-medium.diff.png"))).toBe(true);
  });

  it("passes when the difference is within the anti-aliasing tolerance and writes no diff", async () => {
    const baselines = allBaselines();
    baselines[captureFileName("home", "small")] = "changed";
    const { deps, writes } = setup({ baselines });
    const report = await runVisualRegression({ ...options, aaTolerancePixels: 5 }, deps);
    expect(report.exitCode).toBe(0);
    expect(writes).toEqual([]);
  });

  it("fails a missing baseline without creating it", async () => {
    const baselines = allBaselines();
    delete baselines[captureFileName("jobs_board", "large")];
    const { deps, files, writes } = setup({ baselines });
    const report = await runVisualRegression(options, deps);
    expect(report.exitCode).toBe(1);
    const missing = report.results.filter((r) => r.status === "fail-missing-baseline");
    expect(missing.map((r) => `${r.screen}@${r.size}`)).toEqual(["jobs_board@large"]);
    expect(writes).toEqual([]);
    expect(files.has(path.join(BASELINES, "jobs_board-large.png"))).toBe(false);
  });

  it("overwrites every baseline under update and exits 0", async () => {
    const { deps, files } = setup({ baselines: { "home-small.png": "stale" } });
    const report = await runVisualRegression({ ...options, update: true }, deps);
    expect(report.exitCode).toBe(0);
    expect(report.results.every((r) => r.status === "updated")).toBe(true);
    expect(files.get(path.join(BASELINES, "home-small.png"))?.toString()).toBe("home-small");
    expect(files.size).toBe(SCREENS.length * 3);
  });

  it("exits non-zero when a capture fails, still processes the rest, and keeps the baseline in update mode", async () => {
    const { deps, files } = setup({
      baselines: { "chat-small.png": "old" },
      capture: async (req) => {
        if (req.screen.name === "chat" && req.size.name === "small") {
          throw new Error("navigation timeout");
        }
        return Buffer.from("new");
      },
    });
    const report = await runVisualRegression({ ...options, update: true }, deps);
    expect(report.exitCode).toBe(1);
    expect(report.results).toHaveLength(SCREENS.length * 3);
    expect(report.results.filter((r) => r.status === "error")).toHaveLength(1);
    expect(files.get(path.join(BASELINES, "chat-small.png"))?.toString()).toBe("old");
  });

  it("supports extra configured screens and the screen filter", async () => {
    const screens = [...SCREENS, { name: "jobs_timeline", path: "/?screen=jobs_timeline" }];
    const { deps } = setup({});
    const report = await runVisualRegression(
      { ...options, update: true, screens, only: ["jobs_timeline"] },
      deps,
    );
    expect(report.results.map((r) => r.screen)).toEqual(Array(3).fill("jobs_timeline"));
  });

  it("returns exit code 2 for an unknown screen or an unsafe name", async () => {
    const { deps } = setup({});
    expect((await runVisualRegression({ ...options, only: ["nope"] }, deps)).exitCode).toBe(2);
    const bad = await runVisualRegression(
      { ...options, screens: [{ name: "../x", path: "/" }] },
      deps,
    );
    expect(bad.exitCode).toBe(2);
  });
});

describe("runCli", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it("returns 1 and names the missing baseline", async () => {
    const { deps } = setup({});
    const log = io();
    const code = await runCli(["--baseline-dir", BASELINES, "--screen", "home"], log.io, deps);
    expect(code).toBe(1);
    expect(log.out.join("\n")).toContain("home@small");
    expect(log.out.join("\n")).toContain("missing baseline");
  });

  it("returns 0 under --update", async () => {
    const { deps } = setup({});
    const log = io();
    expect(await runCli(["--update", "--baseline-dir", BASELINES], log.io, deps)).toBe(0);
  });

  it("returns 2 for bad arguments", async () => {
    const { deps } = setup({});
    expect(await runCli(["--bogus"], io().io, deps)).toBe(2);
    expect(await runCli(["--aa-tolerance", "x"], io().io, deps)).toBe(2);
  });
});
