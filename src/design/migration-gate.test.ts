import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseMigrationArgs } from "./migration-gate-cli.js";
import {
  MIGRATION_BRANCH,
  decideMigrationGate,
  formatMigrationGateReport,
  recordPushDecision,
  resolveMigrationDecisionPath,
  runMigrationGate,
  type MigrationBlockerCode,
  type MigrationGateIo,
} from "./migration-gate.js";
import { resolveDesignPaths } from "./paths.js";

const ROOT = "/ws";
const options = { workspaceDir: ROOT };
const paths = resolveDesignPaths(ROOT);
const decisionPath = resolveMigrationDecisionPath(options);

function decisionJson(pushDecision: string, branch = MIGRATION_BRANCH): string {
  return JSON.stringify({
    version: 1,
    branch,
    pushDecision,
    decidedAt: "2026-01-01T00:00:00.000Z",
  });
}

/** In-memory fake. The interface has no write method, so the gate cannot change a file. */
function fakeIo(files: Record<string, string>): MigrationGateIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(p) {
      reads.push(p);
      return files[p];
    },
    async fileExists(p) {
      return p in files;
    },
  };
}

const DECISIONS: Array<{ name: string; content?: string; resolved: boolean }> = [
  { name: "no decision file", content: undefined, resolved: false },
  { name: "unresolved", content: decisionJson("unresolved"), resolved: false },
  { name: "malformed JSON", content: "{nope", resolved: false },
  { name: "invalid pushDecision value", content: decisionJson("maybe"), resolved: false },
  {
    name: "decision for another branch",
    content: decisionJson("approved-by-user", "main"),
    resolved: false,
  },
  { name: "approved-by-user", content: decisionJson("approved-by-user"), resolved: true },
  { name: "declined", content: decisionJson("declined"), resolved: true },
];

describe("migration gate decision matrix", () => {
  for (const decision of DECISIONS) {
    for (const spec of [false, true]) {
      for (const tokens of [false, true]) {
        const name = `${decision.name}, DESIGN.md ${spec ? "present" : "missing"}, tokens.json ${tokens ? "present" : "missing"}`;
        it(name, async () => {
          const files: Record<string, string> = {};
          if (decision.content !== undefined) {
            files[decisionPath] = decision.content;
          }
          if (spec) {
            files[paths.designSpec] = "# spec";
          }
          if (tokens) {
            files[paths.tokens] = "{}";
          }
          const io = fakeIo(files);
          const result = await runMigrationGate(options, io);

          const expected: MigrationBlockerCode[] = [];
          if (!decision.resolved) expected.push("push-decision-unresolved");
          if (!spec) expected.push("design-spec-missing");
          if (!tokens) expected.push("token-file-missing");

          expect(result.blockers.map((b) => b.code)).toEqual(expected);
          expect(result.ok).toBe(expected.length === 0);
        });
      }
    }
  }

  it("names the exact file for each blocker", async () => {
    const result = await runMigrationGate(options, fakeIo({}));
    expect(result.blockers.map((b) => b.path)).toEqual([
      decisionPath,
      paths.designSpec,
      paths.tokens,
    ]);
    const report = formatMigrationGateReport(result);
    expect(report[0]).toContain("REFUSED");
    expect(report[0]).toContain("HUD source is unchanged");
    expect(report.join("\n")).toContain(paths.designSpec);
    expect(report.join("\n")).toContain(paths.tokens);
  });

  it("reports a pass when everything is present", async () => {
    const result = await runMigrationGate(
      options,
      fakeIo({
        [decisionPath]: decisionJson("approved-by-user"),
        [paths.designSpec]: "# spec",
        [paths.tokens]: "{}",
      }),
    );
    expect(result).toEqual({ ok: true, blockers: [] });
    expect(formatMigrationGateReport(result)[0]).toContain("passed");
  });

  it("treats an unreadable decision file as unresolved", async () => {
    const io: MigrationGateIo = {
      async readFile() {
        throw new Error("EACCES");
      },
      async fileExists() {
        return true;
      },
    };
    const result = await runMigrationGate(options, io);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]?.detail).toContain("cannot read");
  });

  it("decideMigrationGate is pure over facts", () => {
    const result = decideMigrationGate({
      decision: { status: "missing", path: "/d" },
      designSpec: { path: "/s", exists: true },
      tokenFile: { path: "/t", exists: true },
    });
    expect(result.blockers.map((b) => b.code)).toEqual(["push-decision-unresolved"]);
  });
});

describe("recordPushDecision", () => {
  it("writes the decision file atomically through the injected writer", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await recordPushDecision(
      options,
      "approved-by-user",
      { note: "user will push" },
      {
        now: () => new Date("2026-02-03T04:05:06.000Z"),
        writeAtomic: async (p, content) => {
          writes.push({ path: p, content });
        },
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(decisionPath);
    expect(JSON.parse(writes[0]?.content ?? "")).toEqual({
      version: 1,
      branch: "upgrade/pi-1.5",
      pushDecision: "approved-by-user",
      decidedAt: "2026-02-03T04:05:06.000Z",
      note: "user will push",
    });
    expect(result.file.pushDecision).toBe("approved-by-user");
  });

  it("writes to disk with no leftover temp file, and the gate reads it back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-gate-"));
    try {
      const real = { workspaceDir: dir };
      const { path: written } = await recordPushDecision(real, "declined");
      expect(fs.readdirSync(path.dirname(written))).toEqual(["migration-decision.json"]);
      const rp = resolveDesignPaths(dir);
      fs.writeFileSync(rp.designSpec, "# spec");
      fs.writeFileSync(rp.tokens, "{}");
      const io = fakeIo({
        [written]: fs.readFileSync(written, "utf8"),
        [rp.designSpec]: "x",
        [rp.tokens]: "x",
      });
      expect((await runMigrationGate(real, io)).ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no partial file when the write fails", async () => {
    await expect(
      recordPushDecision(
        options,
        "declined",
        {},
        {
          writeAtomic: async () => {
            throw new Error("disk full");
          },
        },
      ),
    ).rejects.toThrow("disk full");
  });

  it("rejects an unknown decision value", async () => {
    await expect(
      recordPushDecision(options, "yes" as never, {}, { writeAtomic: async () => undefined }),
    ).rejects.toThrow(/pushDecision/);
  });
});

describe("migration gate CLI", () => {
  it("parses check and record arguments", () => {
    expect(parseMigrationArgs([], "/w")).toMatchObject({ ok: true, command: "check" });
    expect(parseMigrationArgs(["record", "approved-by-user", "--note", "n"], "/w")).toMatchObject({
      ok: true,
      command: "record",
      pushDecision: "approved-by-user",
      note: "n",
    });
    expect(parseMigrationArgs(["record", "bogus"], "/w").ok).toBe(false);
    expect(parseMigrationArgs(["--bad"], "/w").ok).toBe(false);
    expect(parseMigrationArgs(["--root"], "/w").ok).toBe(false);
  });

  it("exits 1 and prints blockers to stderr when refusing", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([], {
      cwd: ROOT,
      io: fakeIo({}),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("design-spec-missing");
  });

  it("exits 0 when the gate passes", async () => {
    const code = await main([], {
      cwd: ROOT,
      io: fakeIo({
        [decisionPath]: decisionJson("approved-by-user"),
        [paths.designSpec]: "x",
        [paths.tokens]: "x",
      }),
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(0);
  });

  it("exits 64 on bad usage", async () => {
    const code = await main(["--nope"], { err: () => undefined });
    expect(code).toBe(64);
  });
});

describe("migration gate never pushes (Requirement 15.4)", () => {
  it("module sources do not import a process spawner or mention git push", () => {
    for (const file of ["migration-gate.ts", "migration-gate-cli.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
      expect(source, file).not.toMatch(/child_process|execFile|execa|spawn|\bexec\(/);
      expect(source, file).not.toMatch(/git\s+push|["']push["']/);
    }
  });
});
