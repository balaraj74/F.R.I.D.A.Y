#!/usr/bin/env bash
# DSPy for FRIDAY's evolution (`pnpm tune`): private venv. Safe to re-run.
set -euo pipefail
V="$HOME/.friday/tools/dspy/venv"
[[ -x "$V/bin/python" ]] || uv venv -q "$V"
VIRTUAL_ENV="$V" uv pip install -q dspy
echo "Installed. Run 'pnpm tune' while FRIDAY is running."
