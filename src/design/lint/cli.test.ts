import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXIT_ABOVE_BASELINE,
  EXIT_OK,
  EXIT_UNREADABLE,
  EXIT_USAGE,
  main,
  parseArgs,
  runDesignLint,
  type LintCliOptions,
  type LintIo,
} from "./cli.js";

const ROOT = "/ws";
const TOKENS = JSON.stringify({ version: 1, radius: { sm: "4px", md: "8px" } });
const baselineJson = (count: number) =>
  JSON.stringify({ version: 1, count, recordedAt: "2026-01-01T00:00:00.000Z" });

type Fs = Record<string, string | Error>;

/** In-memory file system. Keys are absolute file paths. */
function fakeIo(files: Fs, brokenDirs: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const io: LintIo = {
    async readFile(p) {
      const v = written[p] ?? files[p];
      if (v === undefined) {
        throw new Error("ENOENT: no such file");
      }
      if (v instanceof Error) {
        throw v;
      }
      return v;
    },
    async writeFileAtomic(p, content) {
      written[p] = content;
    },
    async listDir(dir) {
      if (brokenDirs.includes(dir)) {
        throw new Error("EACCES: permission denied");
      }
      const prefix = `${dir}/`;
      const children = new Map<string, "file" | "dir">();
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const [head] = rest.split("/");
          children.set(head as string, rest.includes("/") ? "dir" : "file");
        }
      }
      return [...children].map(([name, kind]) => ({ name, kind }));
    },
    now: () => new Date("2026-02-03T04:05:06.000Z"),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io, out, err, written };
}

const options = (over: Partial<LintCliOptions> = {}): LintCliOptions => ({
  rootDir: ROOT,
  srcDir: `${ROOT}/friday-hud/src`,
  tokenFile: `${ROOT}/design/tokens.json`,
  baselineFile: `${ROOT}/design/lint-baseline.json`,
  writeBaseline: false,
  ...over,
});

const base: Fs = {
  "/ws/design/tokens.json": TOKENS,
  "/ws/friday-hud/src/a.tsx": 'const a = "#fff";\nconst b = "#000";\n',
  "/ws/friday-hud/src/sub/b.css": ".x { color: red; }\n",
  "/ws/friday-hud/src/node_modules/pkg/x.js": "#fff",
  "/ws/friday-hud/src/dist/y.js": "#fff",
  "/ws/friday-hud/src/readme.md": "#fff",
};

describe("runDesignLint", () => {
  it("exits 1 and prints the excess above the baseline, listing each violation", async () => {
    const { io, out } = fakeIo({ ...base, "/ws/design/lint-baseline.json": baselineJson(1) });
    expect(await runDesignLint(options(), io)).toBe(EXIT_ABOVE_BASELINE);
    expect(out).toEqual([
      "friday-hud/src/a.tsx:1 hex-color",
      "friday-hud/src/a.tsx:2 hex-color",
      "1 violations above the baseline (2 found, baseline 1)",
    ]);
  });

  it("exits 0 at or below the baseline and skips node_modules, dist and other extensions", async () => {
    const { io, out } = fakeIo({ ...base, "/ws/design/lint-baseline.json": baselineJson(2) });
    expect(await runDesignLint(options(), io)).toBe(EXIT_OK);
    expect(out.at(-1)).toContain("within the baseline of 2");
  });

  it("exempts generated token files from hex-color but not from gradients", async () => {
    const { io, out } = fakeIo({
      "/ws/design/tokens.json": TOKENS,
      "/ws/design/lint-baseline.json": baselineJson(0),
      "/ws/friday-hud/src/tokens.css":
        ":root { --c: #fff; }\n.g { background: linear-gradient(a, b); }\n",
    });
    expect(await runDesignLint(options(), io)).toBe(EXIT_ABOVE_BASELINE);
    expect(out[0]).toBe("friday-hud/src/tokens.css:2 gradient");
  });

  it("uses the Token_File radius scale", async () => {
    const files = {
      "/ws/design/tokens.json": TOKENS,
      "/ws/design/lint-baseline.json": baselineJson(0),
      "/ws/friday-hud/src/r.css": ".a { border-radius: 8px; }\n.b { border-radius: 13px; }\n",
    };
    const { io, out } = fakeIo(files);
    await runDesignLint(options(), io);
    expect(out[0]).toBe("friday-hud/src/r.css:2 bad-radius");
  });

  it.each([
    ["baseline", "/ws/design/lint-baseline.json"],
    ["Token_File", "/ws/design/tokens.json"],
    ["source file", "/ws/friday-hud/src/a.tsx"],
  ])("exits 2 naming an unreadable %s", async (_label, file) => {
    const files: Fs = { ...base, "/ws/design/lint-baseline.json": baselineJson(5) };
    delete files[file];
    const { io, err } = fakeIo({
      ...files,
      ...(file.endsWith("a.tsx") ? { [file]: new Error("EIO") } : {}),
    });
    expect(await runDesignLint(options(), io)).toBe(EXIT_UNREADABLE);
    expect(err.join("\n")).toContain(file);
  });

  it("exits 2 for a malformed baseline or a Token_File without a radius scale", async () => {
    const bad = fakeIo({ ...base, "/ws/design/lint-baseline.json": '{"version":1,"count":-1}' });
    expect(await runDesignLint(options(), bad.io)).toBe(EXIT_UNREADABLE);
    expect(bad.err[0]).toContain("lint-baseline.json");
    const noRadius = fakeIo({
      ...base,
      "/ws/design/tokens.json": "{}",
      "/ws/design/lint-baseline.json": baselineJson(0),
    });
    expect(await runDesignLint(options(), noRadius.io)).toBe(EXIT_UNREADABLE);
    expect(noRadius.err[0]).toContain("tokens.json");
  });

  it("exits 2 naming a source directory that cannot be listed", async () => {
    const { io, err } = fakeIo({ ...base, "/ws/design/lint-baseline.json": baselineJson(5) }, [
      "/ws/friday-hud/src/sub",
    ]);
    expect(await runDesignLint(options(), io)).toBe(EXIT_UNREADABLE);
    expect(err[0]).toContain("/ws/friday-hud/src/sub");
  });

  it("--write-baseline records the count without needing an existing baseline", async () => {
    const { io, written } = fakeIo(base);
    expect(await runDesignLint(options({ writeBaseline: true }), io)).toBe(EXIT_OK);
    expect(JSON.parse(written["/ws/design/lint-baseline.json"] as string)).toEqual({
      version: 1,
      count: 2,
      recordedAt: "2026-02-03T04:05:06.000Z",
    });
  });

  it("scans 2,000 files well within 30 seconds", async () => {
    const files: Fs = {
      "/ws/design/tokens.json": TOKENS,
      "/ws/design/lint-baseline.json": baselineJson(0),
    };
    for (let i = 0; i < 2000; i++) {
      files[`/ws/friday-hud/src/d${i % 20}/f${i}.tsx`] = `const x = "p-2";\n`.repeat(50);
    }
    const { io } = fakeIo(files);
    const started = Date.now();
    expect(await runDesignLint(options(), io)).toBe(EXIT_OK);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("parseArgs and main", () => {
  it("defaults to the repo layout and honours overrides", () => {
    const parsed = parseArgs([], "/repo");
    expect(parsed).toEqual({
      ok: true,
      options: {
        rootDir: "/repo",
        srcDir: path.resolve("/repo/friday-hud/src"),
        tokenFile: path.resolve("/repo/design/tokens.json"),
        baselineFile: path.resolve("/repo/design/lint-baseline.json"),
        writeBaseline: false,
      },
    });
    const custom = parseArgs(["--write-baseline", "--token-file", "t.json"], "/repo");
    expect(custom.ok && custom.options.tokenFile).toBe(path.resolve("/repo/t.json"));
    expect(custom.ok && custom.options.writeBaseline).toBe(true);
  });

  it("rejects unknown flags and missing values with a usage exit code", async () => {
    expect(parseArgs(["--nope"], "/repo").ok).toBe(false);
    expect(parseArgs(["--src"], "/repo").ok).toBe(false);
    const { io, err } = fakeIo({});
    expect(await main(["--nope"], io)).toBe(EXIT_USAGE);
    expect(err[0]).toContain("unknown argument");
  });
});
