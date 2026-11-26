#!/usr/bin/env bash
# ==============================================================================
#  F.R.I.D.A.Y. — One-Command Automated Setup & Provisioning Script
#  Run this script on a new machine to install all dependencies and configure
#  the gateway, extensions, Antigravity proxy, and Holographic HUD.
# ==============================================================================

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo -e "${CYAN}${BOLD}"
cat << "EOF"
  ______ _____  _____ _____             __     __
 |  ____|  __ \|_   _|  __ \   /\ \ \   / /    /\ \
 | |__  | |__) | | | | |  | | /  \ \ \_/ /    /  \ \
 |  __| |  _  /  | | | |  | |/ /\ \ \   /    / /\ \ \
 | |    | | \ \ _| |_| |__| / ____ \ | |    / ____ \ \
 |_|    |_|  \_\_____|_____/_/    \_\|_|   /_/    \_/ \
         SYSTEM INITIALIZATION & ONBOARDING
EOF
echo -e "${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}[1/6] Checking runtime prerequisites...${NC}"

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}[ERROR] Node.js is not installed. Please install Node.js 22+ (https://nodejs.org).${NC}"
  exit 1
fi
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
echo -e "  ✓ Node.js detected: $(node -v)"
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${AMBER}  [WARNING] Node.js 22+ recommended. Current version: $(node -v)${NC}"
fi

# 2. Check or Install pnpm
if ! command -v pnpm &>/dev/null; then
  echo -e "${AMBER}  pnpm not found. Installing pnpm via npm...${NC}"
  npm install -g pnpm || corepack enable pnpm
fi
echo -e "  ✓ pnpm detected: $(pnpm -v)"

# 3. Check Python3
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}[ERROR] Python3 is not installed. Please install python3 & python3-pip.${NC}"
  exit 1
fi
echo -e "  ✓ Python3 detected: $(python3 --version)"

# 4. Check Linux desktop tool dependencies (optional warnings)
for tool in wmctrl xdotool scrot; do
  if ! command -v "$tool" &>/dev/null; then
    echo -e "${AMBER}  [NOTE] '$tool' not found. Recommended for full desktop automation: sudo apt install -y wmctrl xdotool scrot${NC}"
  else
    echo -e "  ✓ Desktop tool '$tool' available."
  fi
done

echo -e "\n${CYAN}[2/6] Installing Monorepo Dependencies...${NC}"
pnpm install

echo -e "\n${CYAN}[3/6] Building F.R.I.D.A.Y. Gateway & Holographic HUD...${NC}"
# Build gateway
pnpm build

# Build HUD widget
if [ -d "$SCRIPT_DIR/friday-hud" ]; then
  echo "  Building friday-hud..."
  (cd "$SCRIPT_DIR/friday-hud" && pnpm install && pnpm build)
fi

echo -e "\n${CYAN}[4/6] Provisioning Antigravity Claude Proxy...${NC}"
if ! command -v antigravity-claude-proxy &>/dev/null && ! command -v acc &>/dev/null; then
  echo "  Installing antigravity-claude-proxy globally..."
  npm install -g antigravity-claude-proxy@2.8.7 || npx -y antigravity-claude-proxy@2.8.7 --help >/dev/null 2>&1 || true
fi
echo -e "  ✓ Antigravity proxy ready."

echo -e "\n${CYAN}[5/6] Initializing Local Environment & Configurations...${NC}"
CONFIG_DIR="$HOME/.friday"
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/logs" "$CONFIG_DIR/openmuse" "$CONFIG_DIR/memory"

# Create default configuration if missing
FRIDAY_CFG="$CONFIG_DIR/friday.json"
if [ ! -f "$FRIDAY_CFG" ]; then
  cat << 'EOF' > "$FRIDAY_CFG"
{
  "gateway": {
    "port": 18789,
    "auth": {
      "token": "friday-local-secure-token"
    }
  },
  "proxy": {
    "url": "http://127.0.0.1:8080"
  },
  "plugins": {
    "openmuse-engine": {
      "enabled": true,
      "workerConcurrency": 2
    }
  }
}
EOF
  echo -e "  ✓ Initialized $FRIDAY_CFG"
fi

# Set up companion prompts if missing in ~/.friday
if [ ! -f "$CONFIG_DIR/IDENTITY.md" ] && [ -f "$SCRIPT_DIR/IDENTITY.md" ]; then
  cp "$SCRIPT_DIR/IDENTITY.md" "$CONFIG_DIR/IDENTITY.md"
fi
if [ ! -f "$CONFIG_DIR/TOOLS.md" ] && [ -f "$SCRIPT_DIR/TOOLS.md" ]; then
  cp "$SCRIPT_DIR/TOOLS.md" "$CONFIG_DIR/TOOLS.md"
fi
if [ ! -f "$CONFIG_DIR/USER.md" ]; then
  if [ -f "$SCRIPT_DIR/USER.template.md" ]; then
    cp "$SCRIPT_DIR/USER.template.md" "$CONFIG_DIR/USER.md"
  elif [ -f "$SCRIPT_DIR/USER.md" ]; then
    cp "$SCRIPT_DIR/USER.md" "$CONFIG_DIR/USER.md"
  fi
  echo -e "  ✓ Created template $CONFIG_DIR/USER.md (personalize this with your info!)"
fi

echo -e "\n${CYAN}[6/6] Finalizing Executables & Launch Permissions...${NC}"
chmod +x "$SCRIPT_DIR/launch_hud_widget.sh" "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/stop.sh" 2>/dev/null || true

echo -e "\n${GREEN}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}  ✓ F.R.I.D.A.Y. INSTALLATION COMPLETE!${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}"
echo -e "${CYAN}To launch everything (Antigravity Proxy + Gateway + Holographic HUD):${NC}"
echo -e "  ${BOLD}./start.sh${NC}"
echo -e ""
echo -e "${CYAN}To stop all running services:${NC}"
echo -e "  ${BOLD}./stop.sh${NC}"
echo -e ""
echo -e "${AMBER}Note: If you want Claude/Antigravity routing, link your Google account:${NC}"
echo -e "  ${BOLD}npx antigravity-claude-proxy accounts add${NC}"
echo -e "${GREEN}${BOLD}================================================================${NC}\n"
