import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDesignPaths } from "../design/paths.js";
import { emptyManifest, runReferencePipeline } from "../design/refs/pipeline.js";
import { ManifestParseError } from "../design/refs/pipeline-defaults.js";
import { planCombinations, type Manifest } from "../design/refs/plan.js";
import { SelectionParseError } from "../design/refs/selection.js";
import { BANNED_PATTERNS, DESIGN_SPEC_SECTIONS } from "../design/spec/index.js";
import { buildTokens } from "../design/tokens/index.js";
import { registerDesignCli, type DesignCliDeps } from "./design.js";

const WORKSPACE = "/work/space";

function createdManifest(count: number): Manifest {
  return {
    version: 1,
    entries: planCombinations()
      .slice(0, count)
      .map((c) => ({
        ...c,
        status: "created",
        source: "image_generate",
        path: `/x/${c.index}.png`,
      })),
  };
}

type Harness = {
  deps: DesignCliDeps;
  logs: string[];
  errors: string[];
  exit: ReturnType<typeof vi.fn>;
  generateImage: ReturnType<typeof vi.fn>;
  captureHtml: ReturnType<typeof vi.fn>;
  writeManifest: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createRefsPipelineDeps: ReturnType<typeof vi.fn>;
};

function harness(overrides: Partial<DesignCliDeps> = {}): Harness {
  const logs: string[] = [];
  const errors: string[] = [];
  const exit = vi.fn();
  const generateImage = vi.fn(async (req: { outputPath: string }) => ({ path: req.outputPath }));
  const captureHtml = vi.fn(async (req: { outputPath: string }) => ({ path: req.outputPath }));
  const writeManifest = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const createRefsPipelineDeps = vi.fn(async () => ({
    deps: { generateImage, captureHtml, sleep: async () => undefined, writeManifest },
    close,
  }));
  const deps: DesignCliDeps = {
    runtime: {
      log: (...a: unknown[]) => void logs.push(a.join(" ")),
      error: (...a: unknown[]) => void errors.push(a.join(" ")),
      exit: exit as unknown as (code: number) => never,
    },
    workspaceDir: () => WORKSPACE,
    readManifest: () => emptyManifest(),
    readSelection: () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runPipeline: runReferencePipeline,
    writeFileAtomic: vi.fn(),
    buildTokens,
    createRefsPipelineDeps,
    ...overrides,
  };
  return {
    deps,
    logs,
    errors,
    exit,
    generateImage,
    captureHtml,
    writeManifest,
    close,
    createRefsPipelineDeps,
  };
}

async function run(h: Harness, ...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerDesignCli(program, h.deps);
  await program.parseAsync(["node", "friday", "design", ...args]);
}

describe("friday design refs", () => {
  it("generates all 18 images into <workspace>/design/refs on a fresh run", async () => {
    const h = harness();
    await run(h, "refs");
    const paths = resolveDesignPaths(WORKSPACE);
    expect(h.generateImage).toHaveBeenCalledTimes(18);
    expect(h.generateImage.mock.calls[0]?.[0].outputPath.startsWith(paths.refsDir)).toBe(true);
    expect(h.createRefsPipelineDeps).toHaveBeenCalledWith(paths);
    expect(h.logs.at(-1)).toContain("18 created, 0 failed, 0 skipped");
    expect(h.logs.at(-1)).toContain(paths.manifest);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(1);
  });

  it("skips entries already created without --regenerate (Req 1.13)", async () => {
    const h = harness({ readManifest: () => createdManifest(10) });
    await run(h, "refs");
    expect(h.generateImage).toHaveBeenCalledTimes(8);
    expect(h.logs.filter((l) => l.startsWith("skip"))).toHaveLength(10);
    expect(h.logs.at(-1)).toContain("8 created, 0 failed, 10 skipped");
  });

  it("regenerates all 18 with --regenerate (Req 1.14)", async () => {
    const h = harness({ readManifest: () => createdManifest(18) });
    await run(h, "refs", "--regenerate");
    expect(h.generateImage).toHaveBeenCalledTimes(18);
    expect(h.logs.at(-1)).toContain("18 created, 0 failed, 0 skipped");
  });

  it("honours --dir for every output path", async () => {
    const h = harness();
    await run(h, "refs", "--dir", "custom");
    expect(h.createRefsPipelineDeps).toHaveBeenCalledWith(resolveDesignPaths(WORKSPACE, "custom"));
  });

  it("reports the selection path and error when malformed, and still runs without writing it", async () => {
    const selectionPath = resolveDesignPaths(WORKSPACE).selection;
    const h = harness({
      readSelection: () => {
        throw new SelectionParseError(selectionPath, "version must be 1");
      },
    });
    await run(h, "refs");
    const message = h.errors.join("\n");
    expect(message).toContain(selectionPath);
    expect(message).toContain("version must be 1");
    expect(message).toContain("left unchanged");
    // Only the manifest writer is wired; nothing in the pipeline can write the selection.
    expect(h.generateImage).toHaveBeenCalledTimes(18);
  });

  it("stops with an error and exit code 1 when the manifest is malformed", async () => {
    const h = harness({
      readManifest: () => {
        throw new ManifestParseError("/m.json", "invalid JSON");
      },
    });
    await run(h, "refs");
    expect(h.errors.join("\n")).toContain("/m.json");
    expect(h.generateImage).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("reports failed entries and exits 1, closing the browser", async () => {
    const h = harness();
    h.generateImage.mockRejectedValue(new Error("boom"));
    h.captureHtml.mockRejectedValue(new Error("no browser"));
    await run(h, "refs");
    expect(h.logs.at(-1)).toContain("0 created, 18 failed");
    expect(h.errors.filter((e) => e.startsWith("Reference image failed"))).toHaveLength(18);
    expect(h.errors[0]).toMatch(/screen "home", direction "instrument"/);
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});

describe("friday design refs with a real selection file", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-design-cli-"));
  });
  afterEach(() => {
    // Test-owned temp dir only.
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("leaves a malformed selection.json byte-for-byte unchanged", async () => {
    const paths = resolveDesignPaths(tmp);
    fs.mkdirSync(paths.dir, { recursive: true });
    const bad = '{"version": 2, "entries": []}';
    fs.writeFileSync(paths.selection, bad);
    const { readSelection } = await import("../design/refs/selection.js");
    const h = harness({ workspaceDir: () => tmp, readSelection });
    await run(h, "refs");
    expect(fs.readFileSync(paths.selection, "utf8")).toBe(bad);
    expect(h.errors.join("\n")).toContain(paths.selection);
    expect(h.errors.join("\n")).toContain("version must be 1");
  });
});

describe("friday design spec / tokens build (real files)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-design-cli-spec-"));
  });
  afterEach(() => {
    // Test-owned temp dir only.
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function realDeps() {
    const { readSelection } = await import("../design/refs/selection.js");
    const { createDefaultDesignCliDeps } = await import("./design.js");
    const real = createDefaultDesignCliDeps();
    return harness({
      workspaceDir: () => tmp,
      readSelection,
      writeFileAtomic: real.writeFileAtomic,
    });
  }

  function writeSelectionFile(verdicts: Array<"keep" | "reject" | "mix">) {
    const paths = resolveDesignPaths(tmp);
    fs.mkdirSync(paths.dir, { recursive: true });
    const entries = verdicts.map((verdict, i) => ({
      screen: "home",
      direction: "instrument",
      index: i % 2,
      verdict,
      note: `note-${i}`,
    }));
    fs.writeFileSync(paths.selection, JSON.stringify({ version: 1, entries }));
    return paths;
  }

  it("writes DESIGN.md with the seven sections and the banned-patterns list", async () => {
    const paths = writeSelectionFile(["keep", "reject"]);
    const h = await realDeps();
    await run(h, "spec");
    const md = fs.readFileSync(paths.designSpec, "utf8");
    for (const section of DESIGN_SPEC_SECTIONS) {
      expect(md).toContain(`## ${section}`);
    }
    for (const pattern of BANNED_PATTERNS) {
      expect(md).toContain(`**${pattern.name}**: ${pattern.definition}`);
    }
    expect(md).toContain("note-0");
    expect(md).not.toContain("note-1");
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("refuses with zero keep/mix verdicts and leaves an existing DESIGN.md byte-identical", async () => {
    const paths = writeSelectionFile(["reject", "reject"]);
    const existing = "# Existing spec\n\nhand written\n";
    fs.writeFileSync(paths.designSpec, existing);
    const before = fs.readFileSync(paths.designSpec);
    const h = await realDeps();
    await run(h, "spec");
    expect(Buffer.compare(fs.readFileSync(paths.designSpec), before)).toBe(0);
    expect(h.errors.join("\n")).toContain("at least one keep or mix verdict is required");
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(fs.readdirSync(paths.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("does not create DESIGN.md when there are zero keep/mix verdicts", async () => {
    const paths = writeSelectionFile([]);
    const h = await realDeps();
    await run(h, "spec");
    expect(fs.existsSync(paths.designSpec)).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("reports a malformed selection file with path and error and writes nothing", async () => {
    const paths = resolveDesignPaths(tmp);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.selection, '{"version": 2, "entries": []}');
    fs.writeFileSync(paths.designSpec, "keep me");
    const h = await realDeps();
    await run(h, "spec");
    expect(h.errors.join("\n")).toContain(paths.selection);
    expect(h.errors.join("\n")).toContain("version must be 1");
    expect(fs.readFileSync(paths.designSpec, "utf8")).toBe("keep me");
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("builds tokens.css and tailwind.tokens.js next to tokens.json", async () => {
    const paths = resolveDesignPaths(tmp);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.tokens, JSON.stringify(validTokenFile()));
    const h = await realDeps();
    await run(h, "tokens", "build");
    expect(path.basename(paths.tokensCss)).toBe("tokens.css");
    expect(path.basename(paths.tailwindTokens)).toBe("tailwind.tokens.js");
    expect(fs.existsSync(paths.tokensCss)).toBe(true);
    expect(fs.existsSync(paths.tailwindTokens)).toBe(true);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("exits non-zero and writes nothing when tokens.json is invalid", async () => {
    const paths = resolveDesignPaths(tmp);
    fs.mkdirSync(paths.dir, { recursive: true });
    const bad = { ...validTokenFile(), radius: {} };
    fs.writeFileSync(paths.tokens, JSON.stringify(bad));
    fs.writeFileSync(paths.tokensCss, "old css");
    const h = await realDeps();
    await run(h, "tokens", "build");
    expect(h.exit).toHaveBeenCalledWith(1);
    expect(h.errors.join("\n")).toContain("/radius");
    expect(fs.readFileSync(paths.tokensCss, "utf8")).toBe("old css");
    expect(fs.existsSync(paths.tailwindTokens)).toBe(false);
  });
});

function validTokenFile() {
  return {
    version: 1,
    color: { ink: "#111111", paper: "#ffffff" },
    type: { body: { size: "16px", weight: 400 }, display: "Inter, sans-serif" },
    spacing: { "2": "8px" },
    radius: { sm: "4px" },
    elevation: { raised: "0 1px 2px #0003" },
    motion: { fast: "120ms" },
    contrastPairs: [{ text: "ink", background: "paper" }],
  };
}
