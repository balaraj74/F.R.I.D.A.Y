import fs from "node:fs/promises";
import path from "node:path";
import { generateOutputs } from "./generate.js";
import type { TokenError } from "./types.js";
import { validateTokenFile } from "./validate.js";

export interface TokensBuildOptions {
  /** Path to `tokens.json`. */
  tokenFilePath: string;
  /** Destination of the generated CSS variables file (`tokens.css`). */
  cssPath: string;
  /** Destination of the generated Tailwind config file (`tailwind.tokens.js`). */
  tailwindPath: string;
  /** Receives human-readable error lines. Defaults to stderr. */
  writeError?: (line: string) => void;
}

export interface TokensBuildResult {
  /** 0 on success, 1 when the Token_File is invalid, 2 when a file cannot be read or written. */
  exitCode: 0 | 1 | 2;
  errors: TokenError[];
  written: string[];
}

function fail(
  exitCode: 1 | 2,
  errors: TokenError[],
  opts: TokensBuildOptions,
  label: string,
): TokensBuildResult {
  const write = opts.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (const err of errors) {
    write(`${label}${err.path || "/"}: ${err.reason}`);
  }
  return { exitCode, errors, written: [] };
}

/** Writes both files to temp names first, then renames, so a failure never leaves one updated and the other not. */
async function writePair(files: Array<{ target: string; content: string }>): Promise<void> {
  const temps: string[] = [];
  try {
    for (const { target, content } of files) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      temps.push(temp);
      await fs.writeFile(temp, content, "utf8");
    }
    for (const [i, { target }] of files.entries()) {
      await fs.rename(temps[i] as string, target);
    }
  } catch (err) {
    // Remove only the temp files this call created.
    await Promise.all(temps.map((t) => fs.unlink(t).catch(() => undefined)));
    throw err;
  }
}

/**
 * Validates the Token_File and, only if it is valid, writes the CSS variables
 * and Tailwind config files. On any failure nothing is written or modified.
 */
export async function buildTokens(opts: TokensBuildOptions): Promise<TokensBuildResult> {
  const label = `${opts.tokenFilePath}:`;
  let raw: string;
  try {
    raw = await fs.readFile(opts.tokenFilePath, "utf8");
  } catch (err) {
    return fail(
      2,
      [{ path: "", reason: `cannot read token file: ${(err as Error).message}` }],
      opts,
      label,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(1, [{ path: "", reason: `invalid JSON: ${(err as Error).message}` }], opts, label);
  }

  const result = validateTokenFile(parsed);
  if (!result.ok) {
    return fail(1, result.errors, opts, label);
  }

  const { css, tailwind } = generateOutputs(result.tokens);
  try {
    await writePair([
      { target: opts.cssPath, content: css },
      { target: opts.tailwindPath, content: tailwind },
    ]);
  } catch (err) {
    return fail(
      2,
      [{ path: "", reason: `cannot write outputs: ${(err as Error).message}` }],
      opts,
      label,
    );
  }
  return { exitCode: 0, errors: [], written: [opts.cssPath, opts.tailwindPath] };
}
