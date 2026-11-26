import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildStepInput, type TaskResult } from "./helpers.js";

// Feature: friday-design-orchestrator-harness, Property 22: Fresh-context Step input excludes prior transcripts
// **Validates: Requirements 6.1**

// Marker carried only by the fields that must never reach a new Step.
const LEAK = "<<prior-step-transcript>>";

const leakyValue = fc.oneof(
  fc.string().map((s) => `${LEAK}${s}`),
  fc.array(
    fc.string().map((s) => ({ role: "assistant", content: `${LEAK}${s}` })),
    {
      maxLength: 4,
    },
  ),
  fc.record({ toolCall: fc.string().map((s) => `${LEAK}${s}`) }),
);

// Names of fields a caller might attach to an upstream result: transcripts, messages, tool calls.
const extraKey = fc.constantFrom(
  "transcript",
  "messages",
  "toolCalls",
  "history",
  "stepTranscript",
  "context",
  "extra",
);

// An upstream result as a caller might actually hold it: the declared fields plus extras.
const upstreamWithExtras = fc
  .record({
    taskId: fc.string({ minLength: 1, maxLength: 12 }),
    result: fc.string({ maxLength: 40 }),
    extras: fc.dictionary(extraKey, leakyValue, { maxKeys: 4 }),
  })
  .map(({ taskId, result, extras }) => ({ ...extras, taskId, result }));

const progressFile = fc.string({ maxLength: 200 });

describe("Property 22: Fresh-context Step input excludes prior transcripts", () => {
  it("contains only the progress file and upstream taskId/result, whatever extras the inputs carry", () => {
    fc.assert(
      fc.property(
        progressFile,
        fc.array(upstreamWithExtras, { maxLength: 6 }),
        (progress, upstream) => {
          // Declared fields captured before the call; extras are what must not leak.
          const expected = upstream.map((u) => ({ taskId: u.taskId, result: u.result }));

          const input = buildStepInput(progress, upstream as TaskResult[]);

          // Top level: exactly progress + upstream.
          expect(Object.keys(input).sort()).toEqual(["progress", "upstream"]);
          expect(input.progress).toBe(progress);

          // Each upstream entry: exactly taskId + result, in the original order.
          expect(input.upstream).toEqual(expected);
          for (const entry of input.upstream) {
            expect(Object.keys(entry).sort()).toEqual(["result", "taskId"]);
          }

          // No prior-step content survives anywhere in the serialized input, unless the
          // declared fields themselves happened to contain the marker.
          const declaredHaveMarker =
            progress.includes(LEAK) ||
            expected.some((e) => e.taskId.includes(LEAK) || e.result.includes(LEAK));
          fc.pre(!declaredHaveMarker);
          expect(JSON.stringify(input)).not.toContain(LEAK);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns a fresh value that does not alias or mutate its arguments", () => {
    fc.assert(
      fc.property(
        progressFile,
        fc.array(upstreamWithExtras, { minLength: 1, maxLength: 6 }),
        (progress, upstream) => {
          const snapshot = structuredClone(upstream);

          const input = buildStepInput(progress, upstream as TaskResult[]);

          // Arguments are untouched, and entries are copies rather than the caller's objects.
          expect(upstream).toEqual(snapshot);
          input.upstream.forEach((entry, i) => {
            expect(entry).not.toBe(upstream[i]);
          });

          // Mutating the caller's objects afterwards does not change the Step input.
          const before = JSON.stringify(input);
          for (const u of upstream) {
            u.result = `${u.result}-changed`;
            (u as Record<string, unknown>).transcript = LEAK;
          }
          expect(JSON.stringify(input)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
