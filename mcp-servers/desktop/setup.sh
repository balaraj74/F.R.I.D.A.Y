#!/usr/bin/env bash
# Screen sight and control for FRIDAY (GNOME on Wayland): private venv + MCP registration. Safe to re-run.
# The venv sees the system's PyGObject (D-Bus portals) and Pillow; Sir approves remote control
# once in a GNOME dialog the first time FRIDAY clicks or types.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/.friday/mcp/desktop/venv"
[[ -x "$VENV/bin/python" ]] || python3 -m venv --system-site-packages "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet mcp
"$VENV/bin/python" -c "import gi, PIL" || { echo "Needs python3-gi and python3-pil from the system."; exit 1; }
echo "Installed. Check it with: $VENV/bin/python $DIR/server.py check"
