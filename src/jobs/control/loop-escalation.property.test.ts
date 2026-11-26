import fc from "fast-check";
import { describe, it } from "vitest";
import { loopResponse, type LoopCause, type LoopFlag, type LoopResponse } from "./loop-detector.js";

// Feature: friday-design-orchestrator-harness, Property 41: Loop response escalation
// Validates: Requirements 10.3, 10.4

const causeArb: fc.Arbitrary<LoopCause> = fc.constantFrom("repeat", "similarity");
const responseArb: fc.Arbitrary<LoopResponse> = fc.constantFrom("change-approach", "fail-task");

/** An earlier flag whose response has not been recorded. */
const unrespondedArb: fc.Arbitrary<LoopFlag> = causeArb.map((cause) => ({ cause }));
/** An earlier flag with a recorded response. */
const respondedArb: fc.Arbitrary<LoopFlag> = fc
  .tuple(causeArb, responseArb)
  .map(([cause, response]) => ({ cause, response }));
/** The flag just raised: it has no recorded response yet. */
const newFlagArb = unrespondedArb;

describe("Property 41: Loop response escalation", () => {
  it("returns change-approach when no earlier flag has a recorded response", () => {
    fc.assert(
      fc.property(fc.array(unrespondedArb, { maxLength: 10 }), newFlagArb, (earlier, latest) => {
        return loopResponse([...earlier, latest]) === "change-approach";
      }),
      { numRuns: 100 },
    );
  });

  it("returns fail-task when any earlier flag has a recorded response", () => {
    fc.assert(
      fc.property(
        fc.array(unrespondedArb, { maxLength: 5 }),
        respondedArb,
        fc.array(fc.oneof(unrespondedArb, respondedArb), { maxLength: 5 }),
        newFlagArb,
        (before, responded, after, latest) => {
          return loopResponse([...before, responded, ...after, latest]) === "fail-task";
        },
      ),
      { numRuns: 100 },
    );
  });
});
