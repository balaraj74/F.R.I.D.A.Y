#!/bin/bash
#
# 🤖 F.R.I.D.A.Y Voice Wake Setup Script
# =====================================
# Installs all dependencies for Voice Wake on Linux
#

set -e

echo "🤖 F.R.I.D.A.Y Voice Wake - Dependency Installer"
echo "================================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    SUDO=""
else
    SUDO="sudo"
fi

echo -e "${CYAN}📦 Installing system dependencies...${NC}"

# Detect package manager
if command -v apt-get &> /dev/null; then
    echo -e "${YELLOW}Detected: Debian/Ubuntu${NC}"
    $SUDO apt-get update
    $SUDO apt-get install -y \
        python3 \
        python3-pip \
        python3-venv \
        portaudio19-dev \
        python3-pyaudio \
        espeak-ng \
        pulseaudio-utils \
        libespeak-ng1 \
        flac
elif command -v dnf &> /dev/null; then
    echo -e "${YELLOW}Detected: Fedora/RHEL${NC}"
    $SUDO dnf install -y \
        python3 \
        python3-pip \
        portaudio-devel \
        espeak-ng \
        pulseaudio-utils \
        flac
elif command -v pacman &> /dev/null; then
    echo -e "${YELLOW}Detected: Arch Linux${NC}"
    $SUDO pacman -S --noconfirm \
        python \
        python-pip \
        portaudio \
        espeak-ng \
        pulseaudio \
        flac
else
    echo -e "${RED}Unknown package manager. Please install dependencies manually:${NC}"
    echo "  - python3, python3-pip"
    echo "  - portaudio (pyaudio dependency)"
    echo "  - espeak-ng (TTS)"
    echo "  - pulseaudio-utils"
    echo "  - flac"
fi

echo ""
echo -e "${CYAN}🐍 Installing Python dependencies...${NC}"

# Create virtual environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/venv"

if [ ! -d "$VENV_DIR" ]; then
    echo -e "${YELLOW}Creating virtual environment...${NC}"
    python3 -m venv "$VENV_DIR"
fi

# Activate virtual environment
source "$VENV_DIR/bin/activate"

# Upgrade pip
pip install --upgrade pip

# Install Python packages
pip install \
    SpeechRecognition \
    PyAudio \
    websocket-client \
    requests

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo -e "${CYAN}To run F.R.I.D.A.Y Voice Wake:${NC}"
echo ""
echo "  cd $SCRIPT_DIR"
echo "  source venv/bin/activate"
echo "  python friday_voice.py"
echo ""
echo -e "${YELLOW}Or use the quick-start script:${NC}"
echo ""
echo "  ./run.sh"
echo ""
