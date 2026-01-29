#!/bin/bash
#
# 🤖 F.R.I.D.A.Y Voice Wake - Quick Start
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/venv"

# Check if venv exists
if [ ! -d "$VENV_DIR" ]; then
    echo "🔧 First run - setting up environment..."
    "$SCRIPT_DIR/setup.sh"
fi

# Activate and run
source "$VENV_DIR/bin/activate"
python "$SCRIPT_DIR/friday_voice.py" "$@"
