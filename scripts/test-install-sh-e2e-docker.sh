#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${FRIDAY_INSTALL_E2E_IMAGE:-friday-install-e2e:local}"
INSTALL_URL="${FRIDAY_INSTALL_URL:-https://friday.ai/install.sh}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
FRIDAY_E2E_MODELS="${FRIDAY_E2E_MODELS:-}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-e2e"

echo "==> Run E2E installer test"
docker run --rm \
  -e FRIDAY_INSTALL_URL="$INSTALL_URL" \
  -e FRIDAY_INSTALL_TAG="${FRIDAY_INSTALL_TAG:-latest}" \
  -e FRIDAY_E2E_MODELS="$FRIDAY_E2E_MODELS" \
  -e FRIDAY_INSTALL_E2E_PREVIOUS="${FRIDAY_INSTALL_E2E_PREVIOUS:-}" \
  -e FRIDAY_INSTALL_E2E_SKIP_PREVIOUS="${FRIDAY_INSTALL_E2E_SKIP_PREVIOUS:-0}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_API_TOKEN="$ANTHROPIC_API_TOKEN" \
  "$IMAGE_NAME"
