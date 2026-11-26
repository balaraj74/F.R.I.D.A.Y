import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOOP_CONFIG, detectRepeatLoop, type ToolCall } from "./loop-detector.js";

// Feature: friday-design-orchestrator-harness, Property 39: Repeated identical tool call loop detection
// **Validates: Requirements 10.1, 10.9**

const TAG = "Feature: friday-design-orchestrator-harness, Property 39";

// Keys start with a letter so they are never integer-like (those would be reordered by the engine).
const keyArb = fc.stringMatching(/^[a-z][a-z0-9]{0,4}$/);
const leafArb = fc.oneof(
  fc.integer({ min: -5, max: 5 }),
  fc.string({ maxLength: 4 }),
  fc.boolean(),
  fc.constant(null),
);
const argsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  leafArb,
  fc.array(leafArb, { maxLength: 3 }),
  fc.dictionary(keyArb, fc.oneof(leafArb, fc.dictionary(keyArb, leafArb, { maxKeys: 3 })), {
    maxKeys: 4,
  }),
);
const toolArb = fc.stringMatching(/^[a-z]{1,6}$/);
const callArb: fc.Arbitrary<ToolCall> = fc.record({ tool: toolArb, arguments: argsArb });

// Tiny pool so repeats are common. Two entries are the same arguments with different key order.
const POOL: ToolCall[] = [
  { tool: "read", arguments: { path: "a", mode: "r" } },
  { tool: "read", arguments: { mode: "r", path: "a" } },
  { tool: "read", arguments: { path: "b", mode: "r" } },
  { tool: "write", arguments: { path: "a", mode: "r" } },
  { tool: "list" },
  { tool: "list", arguments: [] },
];
const pooledCallsArb = fc.array(fc.constantFrom(...POOL), { maxLength: 60 });

/** Deep copy with object keys in reverse order, to prove key order is irrelevant. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) {
      out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Independent identity for a call: tool plus key-order-insensitive arguments. */
function identity(call: ToolCall): string {
  return `${call.tool}\u0000${JSON.stringify(sortKeys(call.arguments)) ?? "undefined"}`;
}

/**
 * Brute-force reference: check every window of `windowSize` consecutive calls (a sequence
 * shorter than the window is one partial window) for an identity occurring > threshold times.
 */
function referenceDetect(calls: readonly ToolCall[], windowSize: number, threshold: number) {
  const lastStart = Math.max(0, calls.length - windowSize);
  for (let start = 0; start <= lastStart; start++) {
    const counts = new Map<string, number>();
    for (const call of calls.slice(start, start + windowSize)) {
      const id = identity(call);
      const n = (counts.get(id) ?? 0) + 1;
      if (n > threshold) {
        return true;
      }
      counts.set(id, n);
    }
  }
  return false;
}

const thresholdArb = fc.integer({ min: 2, max: 20 });
const windowArb = fc.integer({ min: 3, max: 100 });

describe(`${TAG}: ${"Repeated identical tool call loop detection"}`, () => {
  it(`${TAG}: flags iff an identical call occurs more than repeatThreshold times in some window (pooled calls)`, () => {
    fc.assert(
      fc.property(
        pooledCallsArb,
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 3, max: 30 }),
        (calls, threshold, windowSize) => {
          expect(detectRepeatLoop(calls, windowSize, threshold)).toBe(
            referenceDetect(calls, windowSize, threshold),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it(`${TAG}: matches the reference for arbitrary calls and the full configurable ranges`, () => {
    fc.assert(
      fc.property(
        fc.array(callArb, { maxLength: 40 }),
        windowArb,
        thresholdArb,
        (calls, windowSize, threshold) => {
          expect(detectRepeatLoop(calls, windowSize, threshold)).toBe(
            referenceDetect(calls, windowSize, threshold),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`${TAG}: argument key order does not change the result`, () => {
    fc.assert(
      fc.property(
        fc.array(callArb, { maxLength: 40 }),
        fc.integer({ min: 3, max: 15 }),
        fc.integer({ min: 2, max: 6 }),
        (calls, windowSize, threshold) => {
          const reordered = calls.map((c) => ({
            tool: c.tool,
            arguments: reverseKeys(c.arguments),
          }));
          expect(detectRepeatLoop(reordered, windowSize, threshold)).toBe(
            detectRepeatLoop(calls, windowSize, threshold),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`${TAG}: a call repeated threshold+1 times with differently ordered arguments is flagged`, () => {
    fc.assert(
      fc.property(
        thresholdArb,
        fc.dictionary(keyArb, leafArb, { minKeys: 2, maxKeys: 4 }),
        toolArb,
        (threshold, args, tool) => {
          const calls: ToolCall[] = Array.from({ length: threshold + 1 }, (_, i) => ({
            tool,
            arguments: i % 2 === 0 ? args : reverseKeys(args),
          }));
          expect(detectRepeatLoop(calls, threshold + 1, threshold)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it(`${TAG}: sequences where every distinct call occurs at most repeatThreshold times are not flagged`, () => {
    const itemsArb = fc
      .uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 8 })
      .chain((ids) =>
        fc.tuple(
          fc.constant(ids),
          fc.array(fc.integer({ min: 1, max: 20 }), {
            minLength: ids.length,
            maxLength: ids.length,
          }),
        ),
      );
    fc.assert(
      fc.property(
        itemsArb,
        thresholdArb,
        windowArb,
        fc.array(fc.nat(), { minLength: 200, maxLength: 200 }),
        ([ids, wants], threshold, windowSize, priorities) => {
          // Each distinct call appears between 1 and `threshold` times in total.
          const items: { call: ToolCall; prio: number }[] = [];
          ids.forEach((id, i) => {
            const times = 1 + (wants[i] % threshold);
            for (let k = 0; k < times; k++) {
              items.push({
                call: { tool: "t", arguments: { id, extra: [id] } },
                prio: priorities[items.length % priorities.length],
              });
            }
          });
          const calls = items.sort((a, b) => a.prio - b.prio).map((item) => item.call);
          expect(detectRepeatLoop(calls, windowSize, threshold)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it(`${TAG}: repeats spread further apart than the window are not flagged`, () => {
    fc.assert(
      fc.property(thresholdArb, windowArb, (threshold, windowSize) => {
        // threshold+1 identical calls, each separated by windowSize-1 unique filler calls,
        // so no window of windowSize consecutive calls holds more than one of them.
        const calls: ToolCall[] = [];
        for (let i = 0; i < threshold + 1; i++) {
          calls.push({ tool: "same", arguments: { n: 1 } });
          for (let f = 0; f < windowSize - 1; f++) {
            calls.push({ tool: `filler-${i}-${f}` });
          }
        }
        expect(detectRepeatLoop(calls, windowSize, threshold)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it(`${TAG}: threshold+1 identical calls inside one window are flagged, threshold are not`, () => {
    fc.assert(
      fc.property(thresholdArb, fc.integer({ min: 0, max: 30 }), (threshold, fillers) => {
        const windowSize = threshold + 1 + fillers;
        const same = { tool: "same", arguments: { n: 1 } };
        const filler = (i: number): ToolCall => ({ tool: `filler-${i}` });
        const build = (copies: number): ToolCall[] => [
          ...Array.from({ length: copies }, () => same),
          ...Array.from({ length: fillers }, (_, i) => filler(i)),
        ];
        expect(detectRepeatLoop(build(threshold + 1), Math.min(windowSize, 100), threshold)).toBe(
          true,
        );
        expect(detectRepeatLoop(build(threshold), Math.min(windowSize, 100), threshold)).toBe(
          false,
        );
      }),
      { numRuns: 100 },
    );
  });

  it(`${TAG}: a synthetic task repeating one call is flagged by the 10th call with default config`, () => {
    const { windowSize, repeatThreshold } = DEFAULT_LOOP_CONFIG;
    fc.assert(
      fc.property(callArb, (call) => {
        const calls = Array.from({ length: 10 }, () => call);
        let firstFlagged = -1;
        for (let n = 1; n <= calls.length; n++) {
          if (detectRepeatLoop(calls.slice(0, n), windowSize, repeatThreshold)) {
            firstFlagged = n;
            break;
          }
        }
        expect(firstFlagged).toBeGreaterThan(0);
        expect(firstFlagged).toBeLessThanOrEqual(10);
        // "More than 3" means the 4th identical call is the earliest flag.
        expect(firstFlagged).toBe(repeatThreshold + 1);
      }),
      { numRuns: 100 },
    );
  });
});
