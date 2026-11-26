#!/usr/bin/env bash
# Local voice stack for the HUD (offline): whisper.cpp + Whisper small.en + Silero VAD (STT),
# Kokoro-82M via kokoro-js (TTS) and Silero VAD (end-of-speech / barge-in). Everything goes
# under ~/.friday/voice; the HUD starts the servers itself. Safe to re-run.
set -euo pipefail
VOICE="$HOME/.friday/voice"
mkdir -p "$VOICE/models" "$VOICE/node"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required"; exit 1; }

# Speech-to-text
if [[ ! -d "$VOICE/whisper.cpp" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$VOICE/whisper.cpp"
fi
cd "$VOICE/whisper.cpp"
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=ON >/dev/null
cmake --build build -j "$(nproc)" --target whisper-server
[[ -f models/ggml-small.en.bin ]] || bash models/download-ggml-model.sh small.en
[[ -f models/ggml-silero-v5.1.2.bin ]] || bash models/download-vad-model.sh silero-v5.1.2

# Streaming VAD model
[[ -f "$VOICE/models/silero_vad.onnx" ]] || curl -fsSL -o "$VOICE/models/silero_vad.onnx" \
  https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx

# Text-to-speech (Kokoro weights, ~326 MB, download on first start)
cd "$VOICE/node"
[[ -f package.json ]] || npm init -y >/dev/null
npm pkg set type=module >/dev/null
npm install --silent kokoro-js ws
echo "Local voice ready in $VOICE (restart the HUD)."

# Expressive voice (Supertonic 3, ~394 MB; can sigh, breathe and laugh)
ST="$VOICE/supertonic"
mkdir -p "$ST"
[[ -x "$ST/venv/bin/python" ]] || python3 -m venv "$ST/venv"
"$ST/venv/bin/pip" install --quiet supertonic soundfile
"$ST/venv/bin/python" -c "from supertonic import TTS; TTS(model_dir='$ST', auto_download=True)"

# NVIDIA GPU for the expressive voice (~2 GB of CUDA libraries). Optional: without it the voice runs on CPU.
if command -v nvidia-smi >/dev/null; then
  "$ST/venv/bin/pip" uninstall -y onnxruntime >/dev/null 2>&1 || true
  "$ST/venv/bin/pip" install --quiet "onnxruntime-gpu[cuda,cudnn]"
fi
