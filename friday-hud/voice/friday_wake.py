#!/usr/bin/env python3
"""Offline wake word + live transcript sidecar for the FRIDAY HUD.

Audio comes from PipeWire (`pw-record`, 16 kHz mono s16le) so no compiled audio
library is needed. Recognition is Vosk, fully on-device.

Protocol
  stdout: one JSON object per line
    {"type": "ready"}                       model loaded, capturing
    {"type": "wake"}                        "Friday" / "Hey Friday" heard
    {"type": "partial", "text": "..."}      live transcript (transcribe mode)
    {"type": "final", "text": "..."}        end of an utterance (transcribe mode)
    {"type": "error", "message": "..."}
  stdin: one command per line
    wake        listen for the wake word (default)
    transcribe  stream the user's words
    pause       ignore audio (FRIDAY is speaking; avoids waking herself)
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time

SAMPLE_RATE = 16000
CHUNK_BYTES = 4000  # 125 ms of 16-bit mono audio: low latency, low CPU
WAKE_COOLDOWN_S = 2.0
WAKE_WORDS = ("friday",)
DEFAULT_MODEL = os.path.expanduser("~/.friday/models/vosk-model-small-en-us-0.15")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    try:
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except ImportError:
        emit({"type": "error", "message": "vosk not installed; run friday-hud/voice/setup.sh"})
        return 1

    model_dir = os.environ.get("FRIDAY_VOSK_MODEL", DEFAULT_MODEL)
    if not os.path.isdir(model_dir):
        emit({"type": "error", "message": f"Vosk model missing at {model_dir}; run friday-hud/voice/setup.sh"})
        return 1

    SetLogLevel(-1)
    model = Model(model_dir)

    # A tiny grammar makes wake detection fast and resistant to false triggers.
    def new_wake_rec():
        return KaldiRecognizer(model, SAMPLE_RATE, json.dumps(["hey friday", "friday", "[unk]"]))

    wake_rec = new_wake_rec()
    free_rec = KaldiRecognizer(model, SAMPLE_RATE)

    state = {"mode": "wake"}
    lock = threading.Lock()

    rec_proc = None

    def shutdown(*_):
        # Release the microphone immediately; never leave pw-record running.
        if rec_proc and rec_proc.poll() is None:
            rec_proc.terminate()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def read_commands():
        for line in sys.stdin:
            cmd = line.strip()
            if cmd in ("wake", "transcribe", "pause"):
                with lock:
                    if cmd != state["mode"]:
                        state["mode"] = cmd
                        # Fresh recognizers so stale audio never leaks into the next mode.
                        state["reset"] = True
        shutdown()  # parent closed stdin: exit with it

    threading.Thread(target=read_commands, daemon=True).start()

    try:
        rec_proc = subprocess.Popen(
            ["pw-record", "--rate", str(SAMPLE_RATE), "--channels", "1", "--format", "s16", "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        emit({"type": "error", "message": "pw-record not found (PipeWire required)"})
        return 1

    emit({"type": "ready"})
    last_wake = 0.0
    last_partial = ""

    while True:
        data = rec_proc.stdout.read(CHUNK_BYTES)
        if not data:
            emit({"type": "error", "message": "microphone stream ended"})
            return 1

        with lock:
            mode = state["mode"]
            if state.pop("reset", False):
                wake_rec = new_wake_rec()
                free_rec = KaldiRecognizer(model, SAMPLE_RATE)
                last_partial = ""

        if mode == "pause":
            continue

        if mode == "wake":
            done = wake_rec.AcceptWaveform(data)
            text = json.loads(wake_rec.Result() if done else wake_rec.PartialResult()).get(
                "text" if done else "partial", ""
            )
            if any(w in text for w in WAKE_WORDS) and time.monotonic() - last_wake > WAKE_COOLDOWN_S:
                last_wake = time.monotonic()
                wake_rec = new_wake_rec()
                emit({"type": "wake"})
            continue

        # transcribe mode
        if free_rec.AcceptWaveform(data):
            text = json.loads(free_rec.Result()).get("text", "").strip()
            if text:
                emit({"type": "final", "text": text})
            last_partial = ""
        else:
            partial = json.loads(free_rec.PartialResult()).get("partial", "").strip()
            if partial and partial != last_partial:
                last_partial = partial
                emit({"type": "partial", "text": partial})


if __name__ == "__main__":
    sys.exit(main() or 0)
