import { describe, expect, it } from "vitest";
import { buildHtmlMockup } from "./html-mockup.js";
import {
  emptyManifest,
  isResourceExhaustedError,
  MAX_GENERATE_CALLS,
  runReferencePipeline,
  type PipelineDeps,
  type PipelineReport,
} from "./pipeline.js";
import { nextBackoffMs, type Manifest } from "./plan.js";

function makeDeps(overrides: Partial<PipelineDeps> = {}) {
  const sleeps: number[] = [];
  const writes: Manifest[] = [];
  const reports: PipelineReport[] = [];
  const deps: PipelineDeps = {
    generateImage: async (req) => ({ path: req.outputPath }),
    captureHtml: async (req) => ({ path: req.outputPath }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    writeManifest: async (m) => {
      writes.push(structuredClone(m));
    },
    report: (e) => reports.push(e),
    ...overrides,
  };
  return { deps, sleeps, writes, reports };
}

describe("runReferencePipeline", () => {
  it("creates all 18 entries from image_generate on the happy path", async () => {
    const { deps, sleeps, writes } = makeDeps();
    const result = await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(result.manifest.entries).toHaveLength(18);
    expect(result.manifest.entries.every((e) => e.status === "created")).toBe(true);
    expect(result.manifest.entries.every((e) => e.source === "image_generate")).toBe(true);
    expect(sleeps).toEqual([]);
    expect(writes).toHaveLength(18);
  });

  it("retries with doubling delays and falls back to HTML after the retries are used up", async () => {
    let calls = 0;
    const { deps, sleeps } = makeDeps({
      generateImage: async (req) => {
        if (req.screen === "home" && req.direction === "instrument" && req.index === 0) {
          calls++;
          throw new Error("boom");
        }
        return { path: req.outputPath };
      },
    });
    const result = await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(calls).toBe(MAX_GENERATE_CALLS);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 32000]);
    const first = result.manifest.entries[0]!;
    expect(first).toMatchObject({
      screen: "home",
      direction: "instrument",
      status: "created",
      source: "html_fallback",
    });
  });

  it("waits at least 30s after RESOURCE_EXHAUSTED and counts it as a retry", async () => {
    let calls = 0;
    const { deps, sleeps } = makeDeps({
      generateImage: async (req) => {
        if (calls++ < 2) {
          throw new Error("RESOURCE_EXHAUSTED: quota");
        }
        return { path: req.outputPath };
      },
    });
    await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(sleeps).toEqual([nextBackoffMs(1, true), nextBackoffMs(2, true)]);
    expect(sleeps.every((ms) => ms >= 30_000)).toBe(true);
  });

  it("marks an entry failed when the capture fails, names screen and direction, and continues", async () => {
    const { deps, reports } = makeDeps({
      generateImage: async (req) => {
        if (req.screen === "chat" && req.direction === "glass" && req.index === 1) {
          throw new Error("down");
        }
        return { path: req.outputPath };
      },
      captureHtml: async () => {
        throw new Error("no browser");
      },
    });
    const result = await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(result.failed).toHaveLength(1);
    const failed = result.failed[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.source).toBeUndefined();
    expect(failed.failureReason).toContain('"chat"');
    expect(failed.failureReason).toContain('"glass"');
    expect(failed.failureReason).toContain("no browser");
    expect(result.manifest.entries.filter((e) => e.status === "created")).toHaveLength(17);
    expect(
      reports.some((r) => r.kind === "failed" && r.screen === "chat" && r.direction === "glass"),
    ).toBe(true);
  });

  it("never has more than one dependency call in flight", async () => {
    let inFlight = 0;
    let max = 0;
    const track = async <T>(fn: () => T): Promise<T> => {
      inFlight++;
      max = Math.max(max, inFlight);
      await Promise.resolve();
      inFlight--;
      return fn();
    };
    const { deps } = makeDeps({
      generateImage: (req) => track(() => ({ path: req.outputPath })),
    });
    await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(max).toBe(1);
  });

  it("skips created entries unless regenerating", async () => {
    const { deps } = makeDeps();
    const first = await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);

    let calls = 0;
    const counting = makeDeps({
      generateImage: async (req) => {
        calls++;
        return { path: req.outputPath };
      },
    });
    const again = await runReferencePipeline(
      { outDir: "/out", manifest: first.manifest },
      counting.deps,
    );
    expect(calls).toBe(0);
    expect(again.skipped).toBe(18);

    await runReferencePipeline(
      { outDir: "/out", manifest: first.manifest, regenerate: true },
      counting.deps,
    );
    expect(calls).toBe(18);
  });
});

describe("isResourceExhaustedError", () => {
  it("detects status, code and message forms", () => {
    expect(
      isResourceExhaustedError(new Error("Image generation failed (HTTP 429): slow down")),
    ).toBe(true);
    expect(isResourceExhaustedError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(isResourceExhaustedError({ status: 429 })).toBe(true);
    expect(isResourceExhaustedError(new Error("HTTP 500"))).toBe(false);
  });
});

describe("buildHtmlMockup", () => {
  it("is script-free and differs between the two index variants", () => {
    const a = buildHtmlMockup("home", "glass", 0);
    const b = buildHtmlMockup("home", "glass", 1);
    expect(a).not.toContain("<script");
    expect(a).not.toContain("http");
    expect(a).not.toBe(b);
  });
});
