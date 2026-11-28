#!/usr/bin/env node
// Node port of scripts/patch-antigravity-proxy.sh (same effect, works on Windows too).
// Raises antigravity-claude-proxy's hard-coded Gemini output cap (16384 tokens per reply).
// The proxy runs through npx, so it lives in the npx cache and any re-download restores the
// original value. Idempotent; keeps a .orig copy of every file it changes.
// Revert: FRIDAY_PROXY_MAX_OUTPUT=16384 (or restore .orig).
//   node scripts/patch-antigravity-proxy.mjs [version]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "patch-antigravity-proxy";
const LINE_RE = /^export const GEMINI_MAX_OUTPUT_TOKENS = [0-9]+;/m;

/** npm cache root: $npm_config_cache, else ~/.npm (Linux) or %LOCALAPPDATA%\npm-cache (Windows). */
export function npmCacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "npm-cache");
  return path.join(home, ".npm");
}

/** Directories of cached antigravity-claude-proxy installs at exactly `version`. */
export function findCopies(npxCache, version) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(npxCache);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const dir = path.join(npxCache, entry, "node_modules", "antigravity-claude-proxy");
    try {
      const pkg = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      if (pkg.includes(`"version": "${version}"`)) out.push(dir);
    } catch {
      // not a copy
    }
  }
  return out;
}

/** Patch the cap in one constants.js. Returns "patched", "missing" (no file) or "nomatch". */
export function patchFile(file, maxOutput) {
  if (!fs.existsSync(file)) return "missing";
  if (!fs.existsSync(`${file}.orig`)) fs.copyFileSync(file, `${file}.orig`);
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(new RegExp(LINE_RE.source, "gm"), `export const GEMINI_MAX_OUTPUT_TOKENS = ${maxOutput};`);
  if (next !== text) fs.writeFileSync(file, next);
  return new RegExp(`^export const GEMINI_MAX_OUTPUT_TOKENS = ${maxOutput};`, "m").test(next) ? "patched" : "nomatch";
}

export function patchProxy({ version = "2.8.7", maxOutput = process.env.FRIDAY_PROXY_MAX_OUTPUT ?? "65536", env = process.env, warmCache = true, log = console } = {}) {
  if (!/^[0-9]+$/.test(String(maxOutput))) throw new Error("FRIDAY_PROXY_MAX_OUTPUT must be a number");
  const npxCache = path.join(npmCacheDir(env), "_npx");
  // Make sure npx has this version cached, so the copy that is about to start gets patched.
  if (warmCache && findCopies(npxCache, version).length === 0) {
    spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["-y", `antigravity-claude-proxy@${version}`, "--help"], {
      stdio: "ignore",
      shell: process.platform === "win32",
      timeout: 180_000,
    });
  }
  let patched = 0;
  for (const dir of findCopies(npxCache, version)) {
    const file = path.join(dir, "src", "constants.js");
    const result = patchFile(file, String(maxOutput));
    if (result === "patched") patched += 1;
    else if (result === "nomatch") log.error(`${TAG}: pattern not found in ${file} (proxy changed?)`);
  }
  log.log(`${TAG}: ${patched} copy(ies) of ${version} set to ${maxOutput} output tokens`);
  return patched;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    patchProxy({ version: process.argv[2] || "2.8.7" });
  } catch (err) {
    console.error(`${TAG}: ${err.message}`);
    process.exit(1);
  }
}
