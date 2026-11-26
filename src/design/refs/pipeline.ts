// Reference_Image generation pipeline (Requirements 1.2-1.7).
//
// Everything with side effects is injected through `PipelineDeps` (image generator,
// HTML capture, sleep, manifest writer) so tests can drive the pipeline with fakes and a
// fake clock. Real implementations live in pipeline-defaults.ts.
//
// Flow per entry, strictly sequential (at most one dependency call in flight, Req 1.2):
//   1. call image_generate; on failure wait nextBackoffMs() and retry, up to MAX_RETRIES retries
//      (1 initial call + 5 retries = 6 calls; Req 1.3, 1.4)
//   2. when retries are exhausted, build an HTML mockup and capture it (Req 1.5)
//   3. when the capture fails, mark the entry failed, report it, and move on (Req 1.6)
//   4. persist the manifest after every entry, so an interrupted run keeps its progress (Req 1.7)

import { DIRECTION_BRIEFS, SCREEN_BRIEFS, VARIANT_HINT } from "./directions.js";
import { buildHtmlMockup, MOCKUP_VIEWPORT } from "./html-mockup.js";
import {
  entriesToGenerate,
  MAX_RETRIES,
  nextBackoffMs,
  planCombinations,
  type Manifest,
  type ManifestEntry,
  type RefCombination,
} from "./plan.js";

/** Calls made per entry before falling back: the first call plus MAX_RETRIES retries. */
export const MAX_GENERATE_CALLS = MAX_RETRIES + 1;

export type GenerateImageRequest = RefCombination & {
  prompt: string;
  /** Where the caller wants the image. An implementation may change the extension to match the real format. */
  outputPath: string;
};

export type CaptureHtmlRequest = RefCombination & {
  html: string;
  outputPath: string;
  viewport: { width: number; height: number };
};

/** Resolves with the saved file path; rejects when generation fails. */
export type GenerateImageFn = (req: GenerateImageRequest) => Promise<{ path: string }>;
/** Resolves with the saved file path; rejects when the capture fails. */
export type CaptureHtmlFn = (req: CaptureHtmlRequest) => Promise<{ path: string }>;

/** Progress and failure events for the user (Req 1.6). */
export type PipelineReport =
  | (RefCombination & { kind: "skipped" })
  | (RefCombination & {
      kind: "retry";
      /** 1-based retry number about to run. */
      retry: number;
      delayMs: number;
      resourceExhausted: boolean;
      error: string;
    })
  | (RefCombination & { kind: "fallback"; attempts: number; error: string })
  | (RefCombination & { kind: "created"; source: "image_generate" | "html_fallback"; path: string })
  | (RefCombination & { kind: "failed"; reason: string });

export type PipelineDeps = {
  generateImage: GenerateImageFn;
  captureHtml: CaptureHtmlFn;
  /** Injected so tests control time. The pipeline never reads the clock itself. */
  sleep: (ms: number) => Promise<void>;
  /** Persists the full manifest. A rejection aborts the run: the manifest is the source of truth. */
  writeManifest: (manifest: Manifest) => Promise<void>;
  /** Optional observer. Exceptions it throws are ignored. */
  report?: (event: PipelineReport) => void;
};

export type PipelineOptions = {
  /** Directory that receives the images. */
  outDir: string;
  /** Current manifest, or an empty one (`{ version: 1, entries: [] }`). */
  manifest: Manifest;
  /** Regenerate all 18 entries regardless of status (Req 1.14). */
  regenerate?: boolean;
};

export type PipelineResult = {
  manifest: Manifest;
  /** Entries created in this run. */
  created: ManifestEntry[];
  /** Entries that ended failed in this run. */
  failed: ManifestEntry[];
  /** Number of entries skipped because they were already created (Req 1.13). */
  skipped: number;
};

export function emptyManifest(): Manifest {
  return { version: 1, entries: [] };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * True when an image_generate failure is a quota/rate error (Req 1.4).
 * The image tool surfaces HTTP failures as plain `Error` text ("... (HTTP 429): ..."), so this
 * checks the message as well as `code`/`status` fields.
 */
export function isResourceExhaustedError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const { code, status } = err as { code?: unknown; status?: unknown };
    if (status === 429 || (typeof code === "string" && /resource_exhausted/i.test(code))) {
      return true;
    }
  }
  return /RESOURCE_EXHAUSTED|resource has been exhausted|HTTP 429/i.test(errorMessage(err));
}

/** Prompt sent to image_generate for one combination. */
export function buildReferencePrompt(combo: RefCombination): string {
  const dir = DIRECTION_BRIEFS[combo.direction];
  const screen = SCREEN_BRIEFS[combo.screen];
  return [
    `UI design reference image of ${screen.description}, for a desktop assistant app called FRIDAY.`,
    `Style direction "${combo.direction}": ${dir.summary}.`,
    `Visual rules: ${dir.rules}.`,
    `Layout: ${VARIANT_HINT[combo.index]}.`,
    "Render a single flat 16:10 screenshot-style mockup of the whole screen. No device frame, no watermark, no lorem ipsum.",
  ].join(" ");
}

function comboKey(c: RefCombination): string {
  return `${c.screen}/${c.direction}/${c.index}`;
}

function describe(c: RefCombination): string {
  return `Screen "${c.screen}", Style_Direction "${c.direction}" (image ${c.index})`;
}

function stem(c: RefCombination): string {
  return `${c.screen}-${c.direction}-${c.index}`;
}

/** Joins with "/" or "\\" as already used by `outDir`, without importing node:path (keeps this module I/O-free). */
function joinPath(dir: string, file: string): string {
  if (dir === "") {
    return file;
  }
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`;
}

type GenerateOutcome = { ok: true; path: string } | { ok: false; attempts: number; error: string };

async function generateWithRetries(
  combo: RefCombination,
  outputPath: string,
  deps: PipelineDeps,
  emit: (event: PipelineReport) => void,
): Promise<GenerateOutcome> {
  const prompt = buildReferencePrompt(combo);
  for (let call = 1; ; call++) {
    try {
      // Awaited before anything else starts: this is what keeps in-flight calls at 1 (Req 1.2).
      const result = await deps.generateImage({ ...combo, prompt, outputPath });
      if (typeof result?.path !== "string" || result.path === "") {
        throw new Error("image_generate returned no file path");
      }
      return { ok: true, path: result.path };
    } catch (err) {
      const error = errorMessage(err);
      const retry = call; // retry number that would follow this failed call
      if (retry > MAX_RETRIES) {
        return { ok: false, attempts: call, error };
      }
      const resourceExhausted = isResourceExhaustedError(err);
      const delayMs = nextBackoffMs(retry, resourceExhausted);
      emit({ ...combo, kind: "retry", retry, delayMs, resourceExhausted, error });
      await deps.sleep(delayMs);
    }
  }
}

async function produceEntry(
  combo: RefCombination,
  outDir: string,
  deps: PipelineDeps,
  emit: (event: PipelineReport) => void,
): Promise<ManifestEntry> {
  const outputPath = joinPath(outDir, `${stem(combo)}.png`);
  const generated = await generateWithRetries(combo, outputPath, deps, emit);
  if (generated.ok) {
    return { ...combo, status: "created", source: "image_generate", path: generated.path };
  }

  emit({ ...combo, kind: "fallback", attempts: generated.attempts, error: generated.error });
  try {
    const captured = await deps.captureHtml({
      ...combo,
      html: buildHtmlMockup(combo.screen, combo.direction, combo.index),
      outputPath,
      viewport: { ...MOCKUP_VIEWPORT },
    });
    if (typeof captured?.path !== "string" || captured.path === "") {
      throw new Error("capture returned no file path");
    }
    return { ...combo, status: "created", source: "html_fallback", path: captured.path };
  } catch (err) {
    return {
      ...combo,
      status: "failed",
      failureReason:
        `${describe(combo)}: image_generate failed ${generated.attempts} times ` +
        `(last error: ${generated.error}); HTML fallback capture failed: ${errorMessage(err)}`,
    };
  }
}

/**
 * Generates every entry selected by `entriesToGenerate(manifest, regenerate)`, one at a time,
 * and persists the manifest after each. A failed entry never stops the run (Req 1.6).
 * Rejects only when `writeManifest` rejects.
 */
export async function runReferencePipeline(
  options: PipelineOptions,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const emit = (event: PipelineReport): void => {
    try {
      deps.report?.(event);
    } catch {
      // An observer must not break generation.
    }
  };

  const regenerate = options.regenerate ?? false;
  const todo = entriesToGenerate(options.manifest, regenerate);
  const todoKeys = new Set(todo.map(comboKey));

  const byKey = new Map<string, ManifestEntry>();
  for (const entry of options.manifest.entries) {
    byKey.set(comboKey(entry), entry);
  }

  const snapshot = (): Manifest => {
    // Plan order first so the file is stable; entries outside the plan are not expected.
    const entries: ManifestEntry[] = [];
    for (const combo of planCombinations()) {
      const entry = byKey.get(comboKey(combo));
      if (entry) {
        entries.push(entry);
      }
    }
    return { version: 1, entries };
  };

  const skipped = planCombinations().filter((c) => !todoKeys.has(comboKey(c)));
  for (const combo of skipped) {
    emit({ ...combo, kind: "skipped" });
  }

  const created: ManifestEntry[] = [];
  const failed: ManifestEntry[] = [];

  for (const planned of todo) {
    const combo: RefCombination = {
      screen: planned.screen,
      direction: planned.direction,
      index: planned.index,
    };
    const entry = await produceEntry(combo, options.outDir, deps, emit);
    byKey.set(comboKey(entry), entry);
    if (entry.status === "created") {
      created.push(entry);
      emit({ ...combo, kind: "created", source: entry.source!, path: entry.path! });
    } else {
      failed.push(entry);
      emit({ ...combo, kind: "failed", reason: entry.failureReason! });
    }
    await deps.writeManifest(snapshot());
  }

  return { manifest: snapshot(), created, failed, skipped: skipped.length };
}
