#!/usr/bin/env bash
set -euo pipefail

cd /repo

export FRIDAY_STATE_DIR="/tmp/friday-test"
export FRIDAY_CONFIG_PATH="${FRIDAY_STATE_DIR}/friday.json"

echo "==> Seed state"
mkdir -p "${FRIDAY_STATE_DIR}/credentials"
mkdir -p "${FRIDAY_STATE_DIR}/agents/main/sessions"
echo '{}' >"${FRIDAY_CONFIG_PATH}"
echo 'creds' >"${FRIDAY_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${FRIDAY_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm friday reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${FRIDAY_CONFIG_PATH}"
test ! -d "${FRIDAY_STATE_DIR}/credentials"
test ! -d "${FRIDAY_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${FRIDAY_STATE_DIR}/credentials"
echo '{}' >"${FRIDAY_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm friday uninstall --state --yes --non-interactive

test ! -d "${FRIDAY_STATE_DIR}"

echo "OK"
