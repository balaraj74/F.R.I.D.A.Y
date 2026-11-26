#!/usr/bin/env bash
# Google Calendar/Gmail/Tasks for FRIDAY: private venv + MCP registration. Safe to re-run.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/.friday/mcp/google/venv"
[[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet google-api-python-client google-auth-oauthlib mcp
echo "Installed. Sign in with: $DIR/login.sh"
