#!/usr/bin/env bash
# One-time setup for the HUD's offline wake word: a private venv with Vosk and the
# small English model (~40 MB) under ~/.friday. Safe to re-run.
set -euo pipefail

VENV="$HOME/.friday/voice-venv"
MODELS="$HOME/.friday/models"
MODEL="vosk-model-small-en-us-0.15"
URL="https://alphacephei.com/vosk/models/$MODEL.zip"

command -v pw-record >/dev/null || { echo "pw-record (PipeWire) is required"; exit 1; }

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "vosk==0.3.45"
# Neural TTS voice used by the HUD (sends spoken text to Microsoft's Edge TTS service).
"$VENV/bin/pip" install --quiet edge-tts

mkdir -p "$MODELS"
if [[ ! -d "$MODELS/$MODEL" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/model.zip" "$URL"
  python3 -m zipfile -e "$tmp/model.zip" "$MODELS"
fi

"$VENV/bin/python" -c "import vosk; print('vosk', vosk.__version__ if hasattr(vosk, '__version__') else 'ok')"
echo "Wake word ready: $MODELS/$MODEL"
