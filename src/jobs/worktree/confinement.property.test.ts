import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  isWriteAllowed,
  WriteDeniedError,
  worktreePath,
  type WriteScope,
} from "./logic.js";

// Feature: friday-design-orchestrator-harness, Property 38: Writes are confined to the Task's declared paths
// **Validates: Requirements 9.12**

const REPO_ROOT = "/repo";

/** One plain path segment (never `.` or `..`). */
const nameArb = fc.stringMatching(/^[a-z0-9]{1,6}$/);
const idArb = fc.string({ minLength: 1, maxLength: 8 });
/** 1-3 plain segments joined with `/`. */
const subPathArb = fc.array(nameArb, { minLength: 1, maxLength: 3 }).map((s) => s.join("/"));

/**
 * Declared repository paths always live under `/repo/src/`, disjoint from the worktree root
 * (`/repo/.friday/worktrees/<job>/<task>`), so no outside target can match both by accident.
 * Each is generated in relative form (resolved against the repo root) and absolute form.
 */
const declaredArb = fc.tuple(nameArb, fc.boolean()).map(([name, absolute]) => ({
  rel: `src/${name}`,
  abs: `${REPO_ROOT}/src/${name}`,
  declared: absolute ? `${REPO_ROOT}/src/${name}` : `src/${name}`,
}));

type Declared = { rel: string; abs: string; declared: string };

function makeScope(jobId: string, taskId: string, declared: Declared[], absoluteWorktree: boolean) {
  const rel = worktreePath(jobId, taskId);
  const abs = path.resolve(REPO_ROOT, rel);
  const scope: WriteScope = {
    repoRoot: REPO_ROOT,
    worktree: absoluteWorktree ? abs : rel,
    declaredPaths: declared.map((d) => d.declared),
  };
  return { scope, worktreeAbs: abs, declared };
}

type GeneratedScope = ReturnType<typeof makeScope>;

const scopeArb = fc
  .tuple(idArb, idArb, fc.array(declaredArb, { maxLength: 3 }), fc.boolean())
  .map(([jobId, taskId, declared, absoluteWorktree]) =>
    makeScope(jobId, taskId, declared, absoluteWorktree),
  );

/**
 * Make a segment that cannot name the worktree directory itself. Climbing one level and
 * descending into a sibling with the same name as the worktree (`../<taskDir>`) lands back
 * inside the worktree, so "outside" targets that go up and then down must avoid that name.
 */
function notWorktreeName(s: GeneratedScope, segment: string): string {
  return segment === path.basename(s.worktreeAbs) ? `${segment}-x` : segment;
}

/** Same as `notWorktreeName`, applied to the first segment of a `/`-joined sub path. */
function subOutsideWorktreeName(s: GeneratedScope, sub: string): string {
  const [first, ...rest] = sub.split("/");
  return [notWorktreeName(s, first), ...rest].join("/");
}

/** Assert the boolean guard and the throwing variant agree on `expected`. */
function expectDecision(target: string, scope: WriteScope, expected: boolean): void {
  expect(isWriteAllowed(target, scope)).toBe(expected);
  if (expected) {
    expect(() => assertWriteAllowed(target, scope)).not.toThrow();
  } else {
    expect(() => assertWriteAllowed(target, scope)).toThrow(WriteDeniedError);
  }
}

describe("Feature: friday-design-orchestrator-harness, Property 38: Writes are confined to the Task's declared paths", () => {
  it("allows any target inside the worktree (relative, absolute, or with ../ that stays inside)", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, nameArb, nameArb, (s, sub, a, b) => {
        expectDecision(sub, s.scope, true);
        expectDecision(".", s.scope, true);
        expectDecision(s.worktreeAbs, s.scope, true);
        expectDecision(`${s.worktreeAbs}/${sub}`, s.scope, true);
        // Goes one level down and back up, still inside the worktree.
        expectDecision(`${a}/../${b}`, s.scope, true);
      }),
      { numRuns: 200 },
    );
  });

  it("allows any target inside a declared path, in absolute or relative-to-worktree form", () => {
    fc.assert(
      fc.property(
        scopeArb.filter((s) => s.declared.length > 0),
        subPathArb,
        fc.nat(),
        (s, sub, pick) => {
          const d = s.declared[pick % s.declared.length];
          expectDecision(d.abs, s.scope, true);
          expectDecision(`${d.abs}/${sub}`, s.scope, true);
          // Worktree is 4 levels below the repo root, so 4 `..` reaches the repo root.
          expectDecision(`../../../../${d.rel}/${sub}`, s.scope, true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("denies ../ traversal that leaves the worktree", () => {
    fc.assert(
      fc.property(
        scopeArb,
        fc.integer({ min: 1, max: 3 }),
        nameArb,
        nameArb,
        nameArb,
        (s, depth, a, b, c) => {
          // 1-3 levels up stays under /repo/.friday, which is never declared. The name
          // after the climb must not equal the worktree directory name, or `../<name>`
          // would re-enter the worktree.
          expectDecision(`${"../".repeat(depth)}${notWorktreeName(s, a)}`, s.scope, false);
          expectDecision("../".repeat(depth).slice(0, -1), s.scope, false);
          // Down then up past the worktree root.
          expectDecision(`${a}/../../${notWorktreeName(s, b)}`, s.scope, false);
          expectDecision(`${a}/${b}/../../../${notWorktreeName(s, c)}`, s.scope, false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("denies sibling-prefix paths such as <worktree>-evil and <declared>-evil", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, nameArb, (s, sub, suffix) => {
        const evil = `-evil${suffix}`;
        expectDecision(`${s.worktreeAbs}${evil}/${sub}`, s.scope, false);
        expectDecision(`${s.worktreeAbs}${evil}`, s.scope, false);
        expectDecision(`../${path.basename(s.worktreeAbs)}${evil}/${sub}`, s.scope, false);
        for (const d of s.declared) {
          expectDecision(`${d.abs}${evil}/${sub}`, s.scope, false);
          expectDecision(`${d.abs}${evil}`, s.scope, false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("denies absolute paths outside the worktree and declared paths", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, (s, sub) => {
        // Prefixed so a generated segment cannot spell out `repo/src/<declared>`.
        expectDecision(`/x-${sub}`, s.scope, false);
        expectDecision(`/etc/${sub}`, s.scope, false);
        expectDecision(`${REPO_ROOT}/other-${sub}`, s.scope, false);
        expectDecision(REPO_ROOT, s.scope, false);
        expectDecision("/", s.scope, false);
      }),
      { numRuns: 200 },
    );
  });

  it("denies empty targets and targets containing NUL, even when otherwise inside scope", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, fc.nat(), (s, sub, at) => {
        expectDecision("", s.scope, false);
        const nulAt = at % (sub.length + 1);
        const withNul = `${sub.slice(0, nulAt)}\0${sub.slice(nulAt)}`;
        expectDecision(withNul, s.scope, false);
        expectDecision(`${s.worktreeAbs}/${withNul}`, s.scope, false);
        for (const d of s.declared) {
          expectDecision(`${d.abs}/${withNul}`, s.scope, false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("does not let an empty or NUL declared path widen the scope", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, (s, sub) => {
        const widened: WriteScope = { ...s.scope, declaredPaths: ["", "\0", `src\0/${sub}`] };
        // An empty declared path would resolve to the repo root and allow everything if honored.
        expectDecision(`/etc/${sub}`, widened, false);
        expectDecision(`${REPO_ROOT}/${sub}`, widened, false);
        expectDecision(`${sub}`, widened, true);
      }),
      { numRuns: 200 },
    );
  });

  it("denies everything outside the worktree when no declared paths are given", () => {
    fc.assert(
      fc.property(scopeArb, subPathArb, (s, sub) => {
        const bare: WriteScope = { repoRoot: s.scope.repoRoot, worktree: s.scope.worktree };
        expectDecision(`${REPO_ROOT}/src/${sub}`, bare, false);
        expectDecision(`../${subOutsideWorktreeName(s, sub)}`, bare, false);
        expectDecision(sub, bare, true);
      }),
      { numRuns: 200 },
    );
  });

  // Regression: generated names equal to the worktree directory name made `../<name>` resolve
  // back into the worktree, so the "outside" expectation was wrong (test bug, not a guard bug).
  describe("regression: `../<worktree dir name>` is inside the worktree, not outside", () => {
    const s = makeScope(" ", "ref", [], false); // worktree `.friday/worktrees/%20/ref`

    it("treats `../ref` and `a/a/../../../ref` as the worktree itself (allowed)", () => {
      expect(s.worktreeAbs).toBe("/repo/.friday/worktrees/%20/ref");
      expectDecision("../ref", s.scope, true);
      expectDecision("a/a/../../../ref", s.scope, true);
      expectDecision("a/../../ref", s.scope, true);
    });

    it("still denies the sibling directories the generators now produce instead", () => {
      expectDecision("../ref-x", s.scope, false);
      expectDecision("a/a/../../../ref-x", s.scope, false);
      expectDecision("a/../../ref-x", s.scope, false);
    });

    it("keeps the counterexamples from the flaky runs passing under the fixed generators", () => {
      const cases: [string, string, number, string, string, string][] = [
        [" ", "ref", 1, "a", "a", "ref"],
        [" ", "call", 1, "a", "call", "a"],
        [" ", "key", 1, "a", "key", "0"],
      ];
      for (const [job, task, depth, a, b, c] of cases) {
        const sc = makeScope(job, task, [], false);
        expectDecision(`${"../".repeat(depth)}${notWorktreeName(sc, a)}`, sc.scope, false);
        expectDecision(`${a}/../../${notWorktreeName(sc, b)}`, sc.scope, false);
        expectDecision(`${a}/${b}/../../../${notWorktreeName(sc, c)}`, sc.scope, false);
        const bare: WriteScope = { repoRoot: REPO_ROOT, worktree: sc.scope.worktree };
        expectDecision(`../${subOutsideWorktreeName(sc, task)}`, bare, false);
        expectDecision(`../${subOutsideWorktreeName(sc, `${task}/x`)}`, bare, false);
      }
    });
  });
});
