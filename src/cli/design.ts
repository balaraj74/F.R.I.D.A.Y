// `friday design ...` command group. Each subcommand is added by its own `add*Command`
// function (refs, spec, tokens build).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveDesignPaths, type DesignPaths } from "../design/paths.js";
import type { PipelineDeps, PipelineReport, PipelineResult } from "../design/refs/pipeline.js";
import { runReferencePipeline } from "../design/refs/pipeline.js";
import { ManifestParseError, readManifest } from "../design/refs/pipeline-defaults.js";
import type { Manifest } from "../design/refs/plan.js";
import { readSelection, SelectionParseError } from "../design/refs/selection.js";
import { DesignSpecError, generateDesignSpec } from "../design/spec/index.js";
import { buildTokens } from "../design/tokens/index.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

/** Pipeline dependencies without the reporter (the command owns reporting), plus cleanup. */
export type RefsPipelineDeps = {
  deps: Omit<PipelineDeps, "report">;
  /** Releases resources such as the Playwright browser. Called once, even when the run throws. */
  close?: () => Promise<void>;
};

/** Everything with side effects, injectable so tests need no image generation or Playwright. */
export type DesignCliDeps = {
  runtime: Pick<RuntimeEnv, "log" | "error" | "exit">;
  workspaceDir: () => string;
  readManifest: (manifestPath: string) => Manifest;
  readSelection: (selectionPath: string) => unknown;
  runPipeline: typeof runReferencePipeline;
  /** Atomically replaces `filePath` with `content` (temp file in the same dir, then rename). */
  writeFileAtomic: (filePath: string, content: string) => void;
  buildTokens: typeof buildTokens;
  /** Builds the real image_generate / Playwright / manifest-writer dependencies. */
  createRefsPipelineDeps: (paths: DesignPaths) => Promise<RefsPipelineDeps>;
};

export type DesignRefsOptions = {
  regenerate?: boolean;
  /** Overrides the default `<workspace>/design` directory. */
  dir?: string;
};

/** Real dependencies, loaded lazily so `friday design --help` stays cheap. */
async function createRealRefsPipelineDeps(paths: DesignPaths): Promise<RefsPipelineDeps> {
  const [{ loadConfig }, { resolveDefaultAgentId, resolveAgentWorkspaceDir }, imageTool, defaults] =
    await Promise.all([
      import("../config/config.js"),
      import("../agents/agent-scope.js"),
      import("../agents/tools/image-generate-tool.js"),
      import("../design/refs/pipeline-defaults.js"),
    ]);
  const config = loadConfig();
  const tool = imageTool.createImageGenerateTool({
    config,
    workspaceDir: resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)),
  });
  const capture = defaults.createPlaywrightCapture();
  return {
    deps: {
      generateImage: defaults.createImageGenerateAdapter(tool),
      captureHtml: capture.captureHtml,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      writeManifest: defaults.createManifestWriter(paths.manifest),
    },
    close: capture.close,
  };
}

export function createDefaultDesignCliDeps(): DesignCliDeps {
  return {
    runtime: defaultRuntime,
    workspaceDir: () => process.cwd(),
    readManifest,
    readSelection,
    runPipeline: runReferencePipeline,
    writeFileAtomic,
    buildTokens,
    createRefsPipelineDeps: createRealRefsPipelineDeps,
  };
}

/** Temp file in the target directory, fsync, rename: an existing file is never half-written. */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Remove only our own temp file; the target is untouched before the rename.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp file may not exist
    }
    throw err;
  }
}

/** One human-readable line per pipeline event, or null when the event needs no output. */
export function formatPipelineReport(event: PipelineReport): string | null {
  const id = `${event.screen}/${event.direction}/${event.index}`;
  switch (event.kind) {
    case "skipped":
      return `skip     ${id} (already created)`;
    case "retry":
      return `retry    ${id} #${event.retry} in ${Math.round(event.delayMs / 1000)}s${
        event.resourceExhausted ? " (quota)" : ""
      }: ${event.error}`;
    case "fallback":
      return `fallback ${id} after ${event.attempts} failed calls, using HTML mockup: ${event.error}`;
    case "created":
      return `created  ${id} via ${event.source}: ${event.path}`;
    case "failed":
      return `failed   ${id}: ${event.reason}`;
  }
}

/**
 * Reports a malformed Selection_File (path and validation error) without touching it.
 * Generation never writes verdicts, so this is a warning and the run continues (Req 1.12).
 * A missing file is normal before the first review.
 */
function reportSelectionState(paths: DesignPaths, deps: DesignCliDeps): void {
  try {
    deps.readSelection(paths.selection);
  } catch (err) {
    if (err instanceof SelectionParseError) {
      deps.runtime.error(
        `Selection file is malformed and was left unchanged.\n  path: ${err.path}\n  error: ${err.reason}`,
      );
    } else if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** Implements `friday design refs`. Exposed for tests. Resolves to the process exit code. */
export async function runDesignRefs(opts: DesignRefsOptions, deps: DesignCliDeps): Promise<number> {
  const { runtime } = deps;
  const paths = resolveDesignPaths(deps.workspaceDir(), opts.dir);

  let manifest: Manifest;
  try {
    manifest = deps.readManifest(paths.manifest);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      runtime.error(`${err.message}\nThe manifest was left unchanged.`);
      return 1;
    }
    throw err;
  }

  reportSelectionState(paths, deps);

  const pipeline = await deps.createRefsPipelineDeps(paths);
  let result: PipelineResult;
  try {
    result = await deps.runPipeline(
      { outDir: paths.refsDir, manifest, regenerate: opts.regenerate === true },
      {
        ...pipeline.deps,
        report: (event) => {
          const line = formatPipelineReport(event);
          if (line) {
            runtime.log(line);
          }
        },
      },
    );
  } finally {
    await pipeline.close?.().catch(() => undefined);
  }

  runtime.log(
    `Done: ${result.created.length} created, ${result.failed.length} failed, ` +
      `${result.skipped} skipped. Manifest: ${paths.manifest}`,
  );
  for (const entry of result.failed) {
    runtime.error(
      `Reference image failed: screen "${entry.screen}", direction "${entry.direction}": ${entry.failureReason ?? "unknown"}`,
    );
  }
  return result.failed.length > 0 ? 1 : 0;
}

export type DesignDirOptions = {
  /** Overrides the default `<workspace>/design` directory. */
  dir?: string;
};

/**
 * Implements `friday design spec`. Reads the Selection_File and writes DESIGN.md only when
 * at least one keep or mix verdict exists; otherwise an existing DESIGN.md stays unchanged
 * (Req 2.2). Resolves to the process exit code.
 */
export async function runDesignSpec(opts: DesignDirOptions, deps: DesignCliDeps): Promise<number> {
  const { runtime } = deps;
  const paths = resolveDesignPaths(deps.workspaceDir(), opts.dir);

  let selection: ReturnType<typeof readSelection>;
  try {
    selection = deps.readSelection(paths.selection) as ReturnType<typeof readSelection>;
  } catch (err) {
    if (err instanceof SelectionParseError) {
      runtime.error(
        `Selection file is malformed and was left unchanged.\n  path: ${err.path}\n  error: ${err.reason}`,
      );
      return 1;
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      runtime.error(
        `Cannot generate DESIGN.md: selection file not found at ${paths.selection}. ` +
          "Run `friday design refs` and review the images first. " +
          "At least one keep or mix verdict is required.",
      );
      return 1;
    }
    throw err;
  }

  let markdown: string;
  try {
    markdown = generateDesignSpec(selection);
  } catch (err) {
    if (err instanceof DesignSpecError) {
      runtime.error(`${err.message} Existing DESIGN.md (if any) was left unchanged.`);
      return 1;
    }
    throw err;
  }

  deps.writeFileAtomic(paths.designSpec, markdown);
  runtime.log(`Wrote ${paths.designSpec}`);
  return 0;
}

/**
 * Implements `friday design tokens build`. `buildTokens` validates first and writes nothing
 * when the Token_File is invalid (Req 2.9). Resolves to the process exit code.
 */
export async function runDesignTokensBuild(
  opts: DesignDirOptions,
  deps: DesignCliDeps,
): Promise<number> {
  const { runtime } = deps;
  const paths = resolveDesignPaths(deps.workspaceDir(), opts.dir);
  const result = await deps.buildTokens({
    tokenFilePath: paths.tokens,
    cssPath: paths.tokensCss,
    tailwindPath: paths.tailwindTokens,
    writeError: (line) => runtime.error(line),
  });
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  for (const file of result.written) {
    runtime.log(`Wrote ${file}`);
  }
  return 0;
}

function addSpecCommand(design: Command, deps: DesignCliDeps): void {
  design
    .command("spec")
    .description("Generate DESIGN.md from the keep/mix verdicts in selection.json")
    .option("--dir <path>", "Design directory (default: ./design)")
    .action(async (opts: DesignDirOptions) => {
      const code = await runDesignSpec(opts, deps);
      if (code !== 0) {
        deps.runtime.exit(code);
      }
    });
}

function addTokensCommand(design: Command, deps: DesignCliDeps): void {
  const tokens = design.command("tokens").description("Design token tooling");
  tokens
    .command("build")
    .description("Validate tokens.json and generate tokens.css and tailwind.tokens.js")
    .option("--dir <path>", "Design directory (default: ./design)")
    .action(async (opts: DesignDirOptions) => {
      const code = await runDesignTokensBuild(opts, deps);
      if (code !== 0) {
        deps.runtime.exit(code);
      }
    });
}

function addRefsCommand(design: Command, deps: DesignCliDeps): void {
  design
    .command("refs")
    .description("Generate design reference images (2 per style direction per screen)")
    .option("--regenerate", "Regenerate all 18 images, even ones already created")
    .option("--dir <path>", "Design directory (default: ./design)")
    .action(async (opts: DesignRefsOptions) => {
      const code = await runDesignRefs(opts, deps);
      if (code !== 0) {
        deps.runtime.exit(code);
      }
    });
}

export function registerDesignCli(
  program: Command,
  deps: DesignCliDeps = createDefaultDesignCliDeps(),
): Command {
  const design = program
    .command("design")
    .description("Design track: reference images, DESIGN.md and tokens");
  addRefsCommand(design, deps);
  addSpecCommand(design, deps);
  addTokensCommand(design, deps);
  return design;
}
