#!/usr/bin/env python3
"""FRIDAY's expressive local voice (Supertonic 3, offline; localhost only, token-protected).

POST /tts {"text", "voice"?, "speed"?} -> audio/wav. Text may carry <sigh>, <breath>, <laugh>.
GET /health -> {"ok": true, "tts": bool}. Started by the HUD (electron/local-voice.cjs).
"""

import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import onnxruntime as ort
import soundfile as sf

# Use the NVIDIA GPU when the CUDA build is installed: ~24x faster than CPU and frees the cores.
try:
    ort.preload_dlls()  # CUDA/cuDNN libraries shipped as pip packages
except Exception:
    pass
GPU = "CUDAExecutionProvider" in ort.get_available_providers() and os.environ.get("FRIDAY_TTS_DEVICE", "auto") != "cpu"

import supertonic.loader as _loader  # noqa: E402
from supertonic import TTS  # noqa: E402

_loader.DEFAULT_ONNX_PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"] if GPU else ["CPUExecutionProvider"]

PORT = int(os.environ.get("FRIDAY_SUPERTONIC_PORT", "18952"))
TOKEN = os.environ.get("FRIDAY_VOICE_TOKEN", "")
MODEL_DIR = Path.home() / ".friday" / "voice" / "supertonic"
STEPS = 12 if GPU else 5  # more steps = smoother, more natural voice (GPU ~0.3 s per sentence)

tts = None
styles = {}
lock = threading.Lock()  # one generation at a time: they'd only fight over the same cores


def load():
    global tts
    model = TTS(model_dir=str(MODEL_DIR), auto_download=False)
    model.synthesize("Hello.", voice_style=model.get_voice_style(voice_name="F1"), lang="en", total_steps=2)
    tts = model
    print(f"[voice] supertonic ready on {'GPU' if GPU else 'CPU'}", flush=True)


def speak(text, voice, speed):
    with lock:
        style = styles.setdefault(voice, tts.get_voice_style(voice_name=voice))
        wav, _ = tts.synthesize(text, voice_style=style, lang="en", speed=speed, total_steps=STEPS)
    buf = io.BytesIO()
    sf.write(buf, wav.squeeze(), tts.sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, json.dumps({"ok": True, "tts": tts is not None, "device": "gpu" if GPU else "cpu"}).encode())
        self.reply(404)

    def do_POST(self):
        if self.path != "/tts":
            return self.reply(404)
        if TOKEN and self.headers.get("x-friday-voice-token") != TOKEN:
            return self.reply(401)
        if tts is None:
            return self.reply(503)
        try:
            data = json.loads(self.rfile.read(min(int(self.headers.get("content-length", 0)), 20000)) or b"{}")
            text = str(data.get("text", "")).strip()[:2000]
            if not text:
                return self.reply(400)
            wav = speak(text, str(data.get("voice") or "F1"), float(data.get("speed") or 0.95))
            self.reply(200, wav, "audio/wav")
        except Exception as e:
            self.reply(500, json.dumps({"error": str(e)[:300]}).encode())


if __name__ == "__main__":
    threading.Thread(target=load, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
