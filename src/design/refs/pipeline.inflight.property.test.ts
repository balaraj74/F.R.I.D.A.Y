import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  emptyManifest,
  MAX_GENERATE_CALLS,
  runReferencePipeline,
  type PipelineDeps,
} from "./pipeline.js";
import { planCombinations, type Manifest } from "./plan.js";

// Feature: friday-design-orchestrator-harness, Property 2: At most one in-flight generation call
// **Validates: Requirements 1.2**

type CallOutcome = "success" | "failure" | "resource_exhausted";

/** Per-call outcomes consumed in order by the fake image generator; calls past the end succeed. */
const outcomesArb = fc.array(
  fc.constantFrom<CallOutcome>("success", "failure", "resource_exhausted"),
  { maxLength: 150 },
);
/** Per-call async delay, expressed as a number of microtask yields (no real time passes). */
const delaysArb = fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 20 });
/** Outcomes of HTML fallback captures (true = capture succeeds). Cycled when exhausted. */
const capturesArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 20 });

async function yieldTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
  // One macrotask turn gives any wrongly concurrent call a chance to start.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Tracks how many calls are running at once, and the highest count ever seen. */
function createGauge() {
  let current = 0;
  let max = 0;
  let started = 0;
  return {
    async track<T>(delayTicks: number, fn: () => T): Promise<T> {
      started++;
      current++;
      max = Math.max(max, current);
      try {
        await yieldTicks(delayTicks);
        // `await` keeps this call counted as in flight until a nested async call settles.
        return await fn();
      } finally {
        current--;
      }
    },
    get max() {
      return max;
    },
    get started() {
      return started;
    },
    get current() {
      return current;
    },
  };
}

describe("Feature: friday-design-orchestrator-harness, Property 2: At most one in-flight generation call", () => {
  it("never has more than one image_generate call in flight, for any outcome sequence", async () => {
    await fc.assert(
      fc.asyncProperty(outcomesArb, delaysArb, capturesArb, async (outcomes, delays, captures) => {
        const generate = createGauge();
        // Every dependency call (generate, capture, sleep, manifest write) shares one gauge:
        // the pipeline is fully sequential, so none of them may overlap either.
        const all = createGauge();
        let generateCalls = 0;
        let captureCalls = 0;
        const writes: Manifest[] = [];

        const deps: PipelineDeps = {
          generateImage: (req) =>
            all.track(0, () =>
              generate.track(delays[generateCalls % delays.length]!, () => {
                const outcome = outcomes[generateCalls++] ?? "success";
                if (outcome === "failure") {
                  throw new Error("boom");
                }
                if (outcome === "resource_exhausted") {
                  throw new Error("RESOURCE_EXHAUSTED: quota");
                }
                return { path: req.outputPath };
              }),
            ),
          captureHtml: (req) =>
            all.track(1, () => {
              const ok = captures[captureCalls++ % captures.length]!;
              if (!ok) {
                throw new Error("no browser");
              }
              return { path: req.outputPath };
            }),
          // Fake sleep: async, no real delay.
          sleep: (_ms) => all.track(1, () => undefined),
          // In-memory manifest writer.
          writeManifest: (m) =>
            all.track(0, () => {
              writes.push(structuredClone(m));
            }),
        };

        const result = await runReferencePipeline(
          { outDir: "/out", manifest: emptyManifest() },
          deps,
        );

        // The run did real work: at least one call per entry, never more than the per-entry cap.
        const entryCount = planCombinations().length;
        expect(generate.started).toBeGreaterThanOrEqual(entryCount);
        expect(generate.started).toBeLessThanOrEqual(entryCount * MAX_GENERATE_CALLS);
        expect(generate.started).toBe(generateCalls);

        // Property 2: concurrency of image_generate is exactly 1, never 0 overlapping calls.
        expect(generate.max).toBe(1);
        expect(all.max).toBe(1);
        expect(generate.current).toBe(0);
        expect(all.current).toBe(0);

        // Every entry was processed (created or failed) and persisted.
        expect(result.manifest.entries).toHaveLength(entryCount);
        expect(writes).toHaveLength(entryCount);
      }),
      { numRuns: 100 },
    );
  });

  it("keeps the in-flight maximum at 1 when every call is RESOURCE_EXHAUSTED", async () => {
    const generate = createGauge();
    const deps: PipelineDeps = {
      generateImage: () =>
        generate.track(2, () => {
          throw new Error("RESOURCE_EXHAUSTED");
        }),
      captureHtml: async (req) => ({ path: req.outputPath }),
      sleep: async () => {},
      writeManifest: async () => {},
    };
    await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
    expect(generate.max).toBe(1);
    expect(generate.started).toBe(planCombinations().length * MAX_GENERATE_CALLS);
  });
});
