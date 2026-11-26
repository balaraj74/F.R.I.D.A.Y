import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  emptyManifest,
  MAX_GENERATE_CALLS,
  runReferencePipeline,
  type PipelineDeps,
} from "./pipeline.js";
import { MAX_RETRIES, nextBackoffMs, planCombinations, type RefCombination } from "./plan.js";

// Feature: friday-design-orchestrator-harness, Property 4: Manifest entries are consistent with generation outcome
// **Validates: Requirements 1.5, 1.6, 1.7**

/**
 * Scripted outcome for one entry. `failFlags[i]` describes failed image_generate call i:
 * true = RESOURCE_EXHAUSTED, false = plain error.
 * - generated: `failFlags.length` (0..MAX_RETRIES) failures, then image_generate succeeds.
 * - fallback_ok: all MAX_GENERATE_CALLS calls fail, then the HTML capture succeeds.
 * - fallback_fail: all MAX_GENERATE_CALLS calls fail, then the HTML capture fails.
 */
type Outcome =
  | { kind: "generated"; failFlags: boolean[] }
  | { kind: "fallback_ok"; failFlags: boolean[] }
  | { kind: "fallback_fail"; failFlags: boolean[] };

const flagsArb = (min: number, max: number) =>
  fc.array(fc.boolean(), { minLength: min, maxLength: max });

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  flagsArb(0, MAX_RETRIES).map((failFlags) => ({ kind: "generated" as const, failFlags })),
  flagsArb(MAX_GENERATE_CALLS, MAX_GENERATE_CALLS).map((failFlags) => ({
    kind: "fallback_ok" as const,
    failFlags,
  })),
  flagsArb(MAX_GENERATE_CALLS, MAX_GENERATE_CALLS).map((failFlags) => ({
    kind: "fallback_fail" as const,
    failFlags,
  })),
);

/** One outcome per planned entry (18), in plan order. */
const outcomesArb = fc.array(outcomeArb, { minLength: 18, maxLength: 18 });

const key = (c: RefCombination) => `${c.screen}/${c.direction}/${c.index}`;

type LogItem =
  | { op: "generate"; key: string }
  | { op: "sleep"; ms: number }
  | { op: "capture"; key: string };

async function runScripted(outcomes: Outcome[]) {
  const combos = planCombinations();
  const script = new Map(combos.map((c, i) => [key(c), outcomes[i]!]));
  const callsByKey = new Map<string, number>();
  const log: LogItem[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const enter = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
  };
  let manifestWrites = 0;

  const deps: PipelineDeps = {
    generateImage: async (req) => {
      const k = key(req);
      log.push({ op: "generate", key: k });
      await enter();
      const call = callsByKey.get(k) ?? 0;
      callsByKey.set(k, call + 1);
      const outcome = script.get(k)!;
      if (call < outcome.failFlags.length) {
        throw new Error(outcome.failFlags[call] ? "RESOURCE_EXHAUSTED: quota" : "generation boom");
      }
      return { path: `gen:${k}` };
    },
    captureHtml: async (req) => {
      const k = key(req);
      log.push({ op: "capture", key: k });
      await enter();
      if (script.get(k)!.kind === "fallback_fail") {
        throw new Error("capture boom");
      }
      return { path: `html:${k}` };
    },
    sleep: async (ms) => {
      log.push({ op: "sleep", ms });
    },
    writeManifest: async () => {
      manifestWrites++;
    },
  };

  const result = await runReferencePipeline({ outDir: "/out", manifest: emptyManifest() }, deps);
  return { result, log, callsByKey, maxInFlight, manifestWrites, combos };
}

describe("Feature: friday-design-orchestrator-harness, Property 4: Manifest entries are consistent with generation outcome", () => {
  it("created entries have a source and path; failed entries name screen and direction and have no source", async () => {
    await fc.assert(
      fc.asyncProperty(outcomesArb, async (outcomes) => {
        const { result, combos } = await runScripted(outcomes);
        expect(result.manifest.entries).toHaveLength(18);

        result.manifest.entries.forEach((entry, i) => {
          const outcome = outcomes[i]!;
          const combo = combos[i]!;
          expect(key(entry)).toBe(key(combo));
          const k = key(combo);

          if (outcome.kind === "generated") {
            expect(entry).toMatchObject({
              status: "created",
              source: "image_generate",
              path: `gen:${k}`,
            });
            expect(entry.failureReason).toBeUndefined();
          } else if (outcome.kind === "fallback_ok") {
            expect(entry).toMatchObject({
              status: "created",
              source: "html_fallback",
              path: `html:${k}`,
            });
            expect(entry.failureReason).toBeUndefined();
          } else {
            expect(entry.status).toBe("failed");
            expect(entry.source).toBeUndefined();
            expect(entry.path).toBeUndefined();
            expect(entry.failureReason).toContain(`"${entry.screen}"`);
            expect(entry.failureReason).toContain(`"${entry.direction}"`);
          }
        });

        // Result buckets agree with the manifest.
        const expectedFailed = outcomes.filter((o) => o.kind === "fallback_fail").length;
        expect(result.failed).toHaveLength(expectedFailed);
        expect(result.created).toHaveLength(18 - expectedFailed);
        for (const entry of result.manifest.entries) {
          if (entry.status === "created") {
            expect(["image_generate", "html_fallback"]).toContain(entry.source);
            expect(typeof entry.path).toBe("string");
            expect(entry.path).not.toBe("");
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("attempts HTML fallback only after the retries are exhausted, and a capture failure does not stop the run", async () => {
    await fc.assert(
      fc.asyncProperty(outcomesArb, async (outcomes) => {
        const { log, callsByKey, combos, manifestWrites } = await runScripted(outcomes);

        combos.forEach((combo, i) => {
          const k = key(combo);
          const outcome = outcomes[i]!;
          const generateCalls = callsByKey.get(k) ?? 0;
          const captured = log.some((l) => l.op === "capture" && l.key === k);

          // Every entry is processed, even after earlier capture failures.
          expect(generateCalls).toBeGreaterThan(0);
          // Each call counts toward the cap: 1 initial call + MAX_RETRIES retries.
          expect(generateCalls).toBeLessThanOrEqual(MAX_GENERATE_CALLS);

          if (outcome.kind === "generated") {
            expect(generateCalls).toBe(outcome.failFlags.length + 1);
            expect(captured).toBe(false);
          } else {
            expect(generateCalls).toBe(MAX_GENERATE_CALLS);
            expect(captured).toBe(true);
            // The capture happens after the last generate call for this entry.
            const lastGen = log.map((l) => l.op === "generate" && l.key === k).lastIndexOf(true);
            const capIdx = log.findIndex((l) => l.op === "capture" && l.key === k);
            expect(capIdx).toBeGreaterThan(lastGen);
          }
        });

        // Manifest is persisted after every entry (Req 1.7).
        expect(manifestWrites).toBe(18);
        // Entries are processed in plan order, one after another.
        const order = log.filter((l) => l.op === "generate").map((l) => (l as { key: string }).key);
        const firstSeen = [...new Set(order)];
        expect(firstSeen).toEqual(combos.map(key));
      }),
      { numRuns: 100 },
    );
  });

  it("sleeps follow nextBackoffMs for each failed call, with at most MAX_RETRIES delays per entry", async () => {
    await fc.assert(
      fc.asyncProperty(outcomesArb, async (outcomes) => {
        const { log, combos, maxInFlight } = await runScripted(outcomes);
        expect(maxInFlight).toBe(1);

        // Split the log into per-entry segments at the first generate call for each entry.
        let segment = -1;
        const sleepsByEntry: number[][] = combos.map(() => []);
        let prevKey: string | null = null;
        for (const item of log) {
          if (item.op === "generate" && item.key !== prevKey) {
            segment++;
            prevKey = item.key;
          }
          if (item.op === "sleep") {
            sleepsByEntry[segment]!.push(item.ms);
          }
        }

        combos.forEach((_, i) => {
          const outcome = outcomes[i]!;
          // A success after N failures waits N times; exhausting retries waits MAX_RETRIES times
          // (the final failure goes straight to fallback with no delay).
          const delays = Math.min(outcome.failFlags.length, MAX_RETRIES);
          const expected = outcome.failFlags
            .slice(0, delays)
            .map((exhausted, n) => nextBackoffMs(n + 1, exhausted));
          expect(sleepsByEntry[i]).toEqual(expected);
          expect(sleepsByEntry[i]!.length).toBeLessThanOrEqual(MAX_RETRIES);
        });
      }),
      { numRuns: 100 },
    );
  });
});
