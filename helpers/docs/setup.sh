#!/usr/bin/env bash
# Better document reading for FRIDAY's file index: MarkItDown (Office files) and Docling OCR
# (scanned PDFs), CPU-only, in a private venv. Safe to re-run.
set -euo pipefail
V="$HOME/.friday/tools/docs/venv"
[[ -x "$V/bin/python" ]] || uv venv -q "$V"
VIRTUAL_ENV="$V" uv pip install -q --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cpu torch torchvision
VIRTUAL_ENV="$V" uv pip install -q "markitdown[docx,pptx,xlsx,pdf]" docling
cp "$(dirname "${BASH_SOURCE[0]}")/convert.py" "$HOME/.friday/tools/docs/convert.py"
echo "Installed. FRIDAY uses it automatically for Office files and scanned PDFs."
