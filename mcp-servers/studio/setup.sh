#!/usr/bin/env bash
# Installs the studio MCP server's open-source dependencies into ~/.friday/mcp/studio (no sudo).
set -euo pipefail
D="$HOME/.friday/mcp/studio"
mkdir -p "$D"
uv venv --python 3.12 "$D/venv"
uv pip install --python "$D/venv/bin/python" mcp cadquery semgrep pillow cairosvg numpy scipy sympy pint matplotlib trimesh control scikit-fem ezdxf networkx skidl pyserial duckdb pandas scikit-learn ruff radon pyarrow
echo "Studio ready. System tools used if present: ffmpeg, nmap."
