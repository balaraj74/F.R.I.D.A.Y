#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${FRIDAY_IMAGE:-friday:local}"
CONFIG_DIR="${FRIDAY_CONFIG_DIR:-$HOME/.friday}"
WORKSPACE_DIR="${FRIDAY_WORKSPACE_DIR:-$HOME/clawd}"
PROFILE_FILE="${FRIDAY_PROFILE_FILE:-$HOME/.profile}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e FRIDAY_LIVE_TEST=1 \
  -e FRIDAY_LIVE_MODELS="${FRIDAY_LIVE_MODELS:-all}" \
  -e FRIDAY_LIVE_PROVIDERS="${FRIDAY_LIVE_PROVIDERS:-}" \
  -e FRIDAY_LIVE_MODEL_TIMEOUT_MS="${FRIDAY_LIVE_MODEL_TIMEOUT_MS:-}" \
  -e FRIDAY_LIVE_REQUIRE_PROFILE_KEYS="${FRIDAY_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -v "$CONFIG_DIR":/home/node/.friday \
  -v "$WORKSPACE_DIR":/home/node/clawd \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
