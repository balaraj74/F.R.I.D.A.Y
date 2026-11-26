#!/usr/bin/env bash
# Opens Google's sign-in page in your browser; you approve there. The token is saved to
# ~/.friday/google_token.json (only readable by you).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HOME/.friday/mcp/google/venv/bin/python" "$DIR/server.py" login
