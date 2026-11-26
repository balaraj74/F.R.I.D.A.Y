#!/usr/bin/env bash
# Raise antigravity-claude-proxy's hard-coded Gemini output cap (16384 tokens per reply).
#
# The proxy is run through npx, so it lives in the npx cache and any re-download restores the
# original value. Start scripts call this before launching the proxy; it is idempotent and keeps
# a .orig copy of every file it changes. Revert: FRIDAY_PROXY_MAX_OUTPUT=16384 (or restore .orig).
set -euo pipefail

VERSION="${1:-2.8.7}"
MAX_OUTPUT="${FRIDAY_PROXY_MAX_OUTPUT:-65536}"
NPX_CACHE="${npm_config_cache:-$HOME/.npm}/_npx"

if ! [[ "$MAX_OUTPUT" =~ ^[0-9]+$ ]]; then
  echo "patch-antigravity-proxy: FRIDAY_PROXY_MAX_OUTPUT must be a number" >&2
  exit 1
fi

find_copies() {
  local pkg
  for pkg in "$NPX_CACHE"/*/node_modules/antigravity-claude-proxy/package.json; do
    [[ -f "$pkg" ]] || continue
    grep -q "\"version\": \"$VERSION\"" "$pkg" && dirname "$pkg"
  done
}

# Make sure npx has this version cached, so the copy that is about to start gets patched.
if [[ -z "$(find_copies)" ]]; then
  npx -y "antigravity-claude-proxy@$VERSION" --help >/dev/null 2>&1 || true
fi

patched=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  file="$dir/src/constants.js"
  [[ -f "$file" ]] || continue
  [[ -f "$file.orig" ]] || cp "$file" "$file.orig"
  sed -i -E "s/^export const GEMINI_MAX_OUTPUT_TOKENS = [0-9]+;/export const GEMINI_MAX_OUTPUT_TOKENS = $MAX_OUTPUT;/" "$file"
  if grep -q "^export const GEMINI_MAX_OUTPUT_TOKENS = $MAX_OUTPUT;" "$file"; then
    patched=$((patched + 1))
  else
    echo "patch-antigravity-proxy: pattern not found in $file (proxy changed?)" >&2
  fi
done < <(find_copies)

echo "patch-antigravity-proxy: $patched copy(ies) of $VERSION set to $MAX_OUTPUT output tokens"
