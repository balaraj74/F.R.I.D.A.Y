import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AcceptanceCheck, Evidence } from "./types.js";
import { evaluateCheck } from "./verify.js";

// Feature: friday-design-orchestrator-harness, Property 31: Acceptance check evaluation matches its type semantics
// **Validates: Requirements 7.7**

type CheckType = AcceptanceCheck["type"];

// Compile-time guard: adding or removing a check type breaks this Record, so the
// "exactly four check types" claim stays tied to the real union.
const CHECK_TYPES_RECORD: Record<CheckType, true> = {
  tests_pass: true,
  file_exists: true,
  exit_code: true,
  rubric: true,
};
const CHECK_TYPES = Object.keys(CHECK_TYPES_RECORD) as CheckType[];

const exitCodeArb = fc.oneof(
  fc.constantFrom(0, 1, 2, 127, -1),
  fc.integer({ min: -300, max: 300 }),
);
const textArb = fc.string({ maxLength: 12 });
const itemsArb = fc.array(textArb, { maxLength: 6 });

const testsPassCheckArb = textArb.map(
  (command): AcceptanceCheck => ({ type: "tests_pass", command }),
);
const fileExistsCheckArb = textArb.map((path): AcceptanceCheck => ({ type: "file_exists", path }));
const exitCodeCheckArb = fc
  .tuple(textArb, exitCodeArb)
  .map(([command, expected]): AcceptanceCheck => ({ type: "exit_code", command, expected }));
const rubricCheckArb = itemsArb.map((items): AcceptanceCheck => ({ type: "rubric", items }));

const checkArb: fc.Arbitrary<AcceptanceCheck> = fc.oneof(
  testsPassCheckArb,
  fileExistsCheckArb,
  exitCodeCheckArb,
  rubricCheckArb,
);

/** Evidence of the given type with arbitrary content. */
function evidenceOfType(type: CheckType): fc.Arbitrary<Evidence> {
  switch (type) {
    case "tests_pass":
      return exitCodeArb.map((exitCode): Evidence => ({ type, exitCode }));
    case "exit_code":
      return exitCodeArb.map((exitCode): Evidence => ({ type, exitCode }));
    case "file_exists":
      return fc.boolean().map((exists): Evidence => ({ type, exists }));
    case "rubric":
      return itemsArb.map((metItems): Evidence => ({ type, metItems }));
  }
}

const anyEvidenceArb: fc.Arbitrary<Evidence> = fc.oneof(...CHECK_TYPES.map(evidenceOfType));

/** A check paired with evidence of the same type, biased so pass and fail both occur often. */
const matchedArb: fc.Arbitrary<{ check: AcceptanceCheck; evidence: Evidence }> = fc.oneof(
  // tests_pass: exit code 0 is common
  fc.tuple(testsPassCheckArb, fc.oneof(fc.constant(0), exitCodeArb)).map(([check, exitCode]) => ({
    check,
    evidence: { type: "tests_pass", exitCode } as Evidence,
  })),
  // file_exists
  fc.tuple(fileExistsCheckArb, fc.boolean()).map(([check, exists]) => ({
    check,
    evidence: { type: "file_exists", exists } as Evidence,
  })),
  // exit_code: actual equals expected about half the time
  fc.tuple(exitCodeCheckArb, exitCodeArb, fc.boolean()).map(([check, other, same]) => ({
    check,
    evidence: {
      type: "exit_code",
      exitCode: same && check.type === "exit_code" ? check.expected : other,
    } as Evidence,
  })),
  // rubric: met items are a shuffled subset/superset of the required items
  fc
    .tuple(itemsArb, fc.array(textArb, { maxLength: 3 }), fc.array(fc.boolean(), { maxLength: 6 }))
    .map(([items, extra, keep]) => ({
      check: { type: "rubric", items } as AcceptanceCheck,
      evidence: {
        type: "rubric",
        metItems: [...items.filter((_, i) => keep[i] ?? true), ...extra],
      } as Evidence,
    })),
);

function expectedResult(check: AcceptanceCheck, evidence: Evidence): "pass" | "fail" {
  if (check.type === "tests_pass" && evidence.type === "tests_pass") {
    return evidence.exitCode === 0 ? "pass" : "fail";
  }
  if (check.type === "file_exists" && evidence.type === "file_exists") {
    return evidence.exists ? "pass" : "fail";
  }
  if (check.type === "exit_code" && evidence.type === "exit_code") {
    return evidence.exitCode === check.expected ? "pass" : "fail";
  }
  if (check.type === "rubric" && evidence.type === "rubric") {
    return check.items.every((item) => evidence.metItems.includes(item)) ? "pass" : "fail";
  }
  throw new Error("expectedResult called with mismatched check/evidence");
}

describe("Feature: friday-design-orchestrator-harness, Property 31: Acceptance check evaluation matches its type semantics", () => {
  it("exactly four check types exist: tests_pass, file_exists, exit_code, rubric", () => {
    expect([...CHECK_TYPES].sort()).toEqual(["exit_code", "file_exists", "rubric", "tests_pass"]);
  });

  it("matching evidence yields pass iff the type's semantics hold, otherwise fail", () => {
    fc.assert(
      fc.property(matchedArb, ({ check, evidence }) => {
        expect(evaluateCheck(check, evidence)).toBe(expectedResult(check, evidence));
      }),
      { numRuns: 300 },
    );
  });

  it("tests_pass passes iff the evidence exit code is 0", () => {
    fc.assert(
      fc.property(testsPassCheckArb, exitCodeArb, (check, exitCode) => {
        const result = evaluateCheck(check, { type: "tests_pass", exitCode });
        expect(result).toBe(exitCode === 0 ? "pass" : "fail");
      }),
      { numRuns: 200 },
    );
  });

  it("file_exists passes iff the evidence says the file exists", () => {
    fc.assert(
      fc.property(fileExistsCheckArb, fc.boolean(), (check, exists) => {
        expect(evaluateCheck(check, { type: "file_exists", exists })).toBe(
          exists ? "pass" : "fail",
        );
      }),
      { numRuns: 100 },
    );
  });

  it("exit_code passes iff actual equals expected", () => {
    fc.assert(
      fc.property(textArb, exitCodeArb, exitCodeArb, (command, expected, actual) => {
        const result = evaluateCheck(
          { type: "exit_code", command, expected },
          { type: "exit_code", exitCode: actual },
        );
        expect(result).toBe(actual === expected ? "pass" : "fail");
      }),
      { numRuns: 200 },
    );
  });

  it("exit_code passes when actual equals expected, including non-zero codes", () => {
    fc.assert(
      fc.property(textArb, exitCodeArb, (command, expected) => {
        expect(
          evaluateCheck(
            { type: "exit_code", command, expected },
            { type: "exit_code", exitCode: expected },
          ),
        ).toBe("pass");
      }),
      { numRuns: 100 },
    );
  });

  it("rubric passes iff every item is met", () => {
    fc.assert(
      fc.property(itemsArb, itemsArb, (items, metItems) => {
        const result = evaluateCheck({ type: "rubric", items }, { type: "rubric", metItems });
        expect(result).toBe(items.every((i) => metItems.includes(i)) ? "pass" : "fail");
      }),
      { numRuns: 200 },
    );
  });

  it("rubric with all items met (plus extras) passes, and an empty rubric passes vacuously", () => {
    fc.assert(
      fc.property(itemsArb, itemsArb, (items, extra) => {
        expect(
          evaluateCheck(
            { type: "rubric", items },
            { type: "rubric", metItems: [...extra, ...items] },
          ),
        ).toBe("pass");
      }),
      { numRuns: 100 },
    );
    expect(evaluateCheck({ type: "rubric", items: [] }, { type: "rubric", metItems: [] })).toBe(
      "pass",
    );
  });

  it("rubric with a required item missing from the met items fails", () => {
    fc.assert(
      fc.property(itemsArb, textArb, (others, missing) => {
        const items = [...others, missing];
        const metItems = items.filter((i) => i !== missing);
        expect(evaluateCheck({ type: "rubric", items }, { type: "rubric", metItems })).toBe("fail");
      }),
      { numRuns: 100 },
    );
  });

  it("returns no-evidence when no evidence was recorded", () => {
    fc.assert(
      fc.property(checkArb, (check) => {
        expect(evaluateCheck(check)).toBe("no-evidence");
        expect(evaluateCheck(check, undefined)).toBe("no-evidence");
      }),
      { numRuns: 100 },
    );
  });

  it("returns no-evidence when the evidence type differs from the check type", () => {
    fc.assert(
      fc.property(checkArb, anyEvidenceArb, (check, evidence) => {
        fc.pre(evidence.type !== check.type);
        expect(evaluateCheck(check, evidence)).toBe("no-evidence");
      }),
      { numRuns: 300 },
    );
  });
});
