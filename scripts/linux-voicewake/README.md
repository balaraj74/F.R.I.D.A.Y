# 🤖 F.R.I.D.A.Y Voice Wake for Linux

Always-on voice assistant with **"Friday"** wake word detection.

## Features

- 🎤 **Wake Word Detection** — Say "Friday", "Hey Friday", or "OK Friday" to activate
- 🗣️ **Voice Commands** — Speak naturally after wake word
- 🔊 **Text-to-Speech** — Hear responses spoken aloud
- 🔗 **Gateway Integration** — Connects to F.R.I.D.A.Y Gateway

## Quick Start

### 1. Install Dependencies

```bash
cd scripts/linux-voicewake
chmod +x setup.sh run.sh
./setup.sh
```

This installs:
- Python packages: `SpeechRecognition`, `PyAudio`, `websocket-client`
- System packages: `portaudio`, `espeak-ng`, `pulseaudio-utils`, `flac`

### 2. Start F.R.I.D.A.Y Gateway

In another terminal:
```bash
pnpm friday gateway
```

### 3. Run Voice Wake

```bash
./run.sh
```

Or manually:
```bash
source venv/bin/activate
python friday_voice.py
```

## Usage

```
███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗
██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝
█████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝ 
██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝  
██║     ██║  ██║██║██████╔╝██║  ██║   ██║   
╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   

        🤖 Voice Wake for Linux 🤖
        Say "Friday" to wake me up!

🚀 F.R.I.D.A.Y Voice Wake is now active!
   Wake words: friday, hey friday, ok friday
   Gateway: ws://127.0.0.1:18789
   TTS: enabled

Press Ctrl+C to stop.

👂 Listening for wake word: friday, hey friday, ok friday...
```

1. **Say "Friday"** — The assistant wakes up
2. **Speak your command** — "What's the weather today?"
3. **Hear the response** — F.R.I.D.A.Y speaks the answer

## Command Line Options

```bash
python friday_voice.py --help
```

| Option | Description |
|--------|-------------|
| `--wake-word`, `-w` | Custom wake word (can use multiple times) |
| `--gateway-url`, `-g` | Gateway WebSocket URL (default: ws://127.0.0.1:18789) |
| `--token`, `-t` | Gateway authentication token |
| `--no-tts` | Disable spoken responses |

### Examples

```bash
# Custom wake word
python friday_voice.py -w "jarvis" -w "computer"

# Connect to remote gateway
python friday_voice.py -g ws://192.168.1.100:18789

# Text output only (no speech)
python friday_voice.py --no-tts
```

## Troubleshooting

### Microphone not detected

```bash
# List audio devices
arecord -l

# Test microphone
arecord -d 5 test.wav && aplay test.wav
```

### No sound output

```bash
# Test TTS
espeak-ng "Hello Friday"

# Check PulseAudio
pulseaudio --check && echo "PulseAudio running"
```

### Speech recognition errors

- Ensure you have internet connectivity (uses Google Speech API)
- Speak clearly and at normal volume
- Reduce background noise

## Requirements

- Python 3.8+
- Linux with PulseAudio or ALSA
- Working microphone
- Internet connection (for speech recognition)
- F.R.I.D.A.Y Gateway running

## Developer

**Balaraj R** — [balarajr483@gmail.com](mailto:balarajr483@gmail.com)
