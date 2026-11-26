import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyFirstDecision, type ApprovalDecision } from "./approvals.js";

// Feature: friday-design-orchestrator-harness, Property 34: First approval decision wins
// **Validates: Requirements 8.6**

const decisionArb: fc.Arbitrary<ApprovalDecision> = fc.record({
  at: fc.integer({ min: 0, max: 1_000 }),
  decision: fc.constantFrom<"approve" | "deny">("approve", "deny"),
});

// Small `at` range makes ties frequent.
const nonEmptyArb = fc.array(decisionArb, { minLength: 1, maxLength: 20 });

describe("Property 34: First approval decision wins", () => {
  it("returns the decision with minimal `at`, ties going to the earliest input entry", () => {
    fc.assert(
      fc.property(nonEmptyArb, (decisions) => {
        const minAt = Math.min(...decisions.map((d) => d.at));
        const expected = decisions.find((d) => d.at === minAt) as ApprovalDecision;
        expect(applyFirstDecision(decisions)).toEqual({
          at: expected.at,
          decision: expected.decision,
        });
      }),
      { numRuns: 100 },
    );
  });

  it("is unaffected by the order or content of later decisions", () => {
    fc.assert(
      fc.property(
        decisionArb,
        fc.array(decisionArb, { maxLength: 15 }),
        fc.nat(),
        fc.infiniteStream(fc.nat()),
        (winner, laterRaw, position, randoms) => {
          // Every other decision is strictly later than the winner.
          const later = laterRaw.map((d) => ({ ...d, at: winner.at + 1 + d.at }));
          const shuffled = [...later];
          const it = randoms[Symbol.iterator]();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = (it.next().value as number) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          const insertAt = position % (later.length + 1);
          const withWinner = (rest: ApprovalDecision[]) => [
            ...rest.slice(0, insertAt),
            winner,
            ...rest.slice(insertAt),
          ];
          const expected = { at: winner.at, decision: winner.decision };
          expect(applyFirstDecision(withWinner(later))).toEqual(expected);
          expect(applyFirstDecision(withWinner(shuffled))).toEqual(expected);
          expect(applyFirstDecision(withWinner([...later].toReversed()))).toEqual(expected);
          expect(applyFirstDecision([winner])).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns null for an empty list", () => {
    expect(applyFirstDecision([])).toBeNull();
  });

  it("does not mutate its input", () => {
    fc.assert(
      fc.property(fc.array(decisionArb, { maxLength: 20 }), (decisions) => {
        const snapshot = structuredClone(decisions);
        const frozen = decisions.map((d) => Object.freeze({ ...d }));
        Object.freeze(frozen);
        applyFirstDecision(frozen);
        applyFirstDecision(decisions);
        expect(decisions).toEqual(snapshot);
        expect(frozen).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
