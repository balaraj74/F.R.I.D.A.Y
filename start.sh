#!/usr/bin/env bash
# ==============================================================================
#  F.R.I.D.A.Y. — One-Command Master Launcher
#  Boots:
#    1. Antigravity Claude Proxy (:8080)
#    2. F.R.I.D.A.Y. Gateway Daemon (:18789)
#    3. Holographic Desktop HUD Widget (Electron)
# ==============================================================================

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p "$HOME/.friday/logs"

echo -e "${CYAN}${BOLD}[FRIDAY MASTER BOOT] Initiating full system startup...${NC}"

# Helper function to check open ports
check_port() {
  local port=$1
  if command -v nc &>/dev/null; then
    nc -z 127.0.0.1 "$port" 2>/dev/null
  else
    (echo > /dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
  fi
}

# 1. Antigravity Claude Proxy (:8080)
echo -e "${CYAN}[1/3] Checking Antigravity Claude Proxy (:8080)...${NC}"
if check_port 8080; then
  echo -e "  ✓ Proxy is already active on :8080"
else
  echo "  Starting Antigravity Proxy..."
  # Raise the proxy's hard-coded 16k Gemini output cap (re-applied after npx re-downloads).
  bash "$(dirname "$0")/scripts/patch-antigravity-proxy.sh" 2.8.7 || true
  if command -v antigravity-claude-proxy &>/dev/null; then
    antigravity-claude-proxy start >/dev/null 2>&1 &
  elif command -v acc &>/dev/null; then
    acc start >/dev/null 2>&1 &
  else
    npx -y antigravity-claude-proxy@2.8.7 start >/dev/null 2>&1 &
  fi

  for i in {1..20}; do
    sleep 0.3
    if check_port 8080; then
      break
    fi
  done

  if check_port 8080; then
    echo -e "  ${GREEN}✓ Antigravity Proxy online on http://127.0.0.1:8080${NC}"
  else
    echo -e "  ${AMBER}[NOTE] Proxy starting in background (continuing boot)${NC}"
  fi
fi

# 2. F.R.I.D.A.Y. Gateway Daemon (:18789)
echo -e "${CYAN}[2/3] Checking F.R.I.D.A.Y. Gateway Daemon (:18789)...${NC}"
if check_port 18789; then
  echo -e "  ✓ Gateway is already active on :18789"
else
  echo "  Starting Gateway daemon..."
  if command -v tmux &>/dev/null; then
    tmux kill-session -t friday 2>/dev/null || true
    tmux new-session -d -s friday "cd '$SCRIPT_DIR' && node friday.mjs gateway --force 2>&1 | tee -a '$HOME/.friday/logs/gateway.log'"
  else
    pkill -f "friday gateway" 2>/dev/null || true
    nohup node friday.mjs gateway --force > "$HOME/.friday/logs/gateway.log" 2>&1 &
  fi

  for i in {1..30}; do
    sleep 0.4
    if check_port 18789; then
      break
    fi
  done

  if check_port 18789; then
    echo -e "  ${GREEN}✓ F.R.I.D.A.Y. Gateway online on ws://127.0.0.1:18789${NC}"
  else
    echo -e "  ${AMBER}[NOTE] Gateway initializing (logs at ~/.friday/logs/gateway.log)${NC}"
  fi
fi

# 3. Holographic Desktop HUD Widget
echo -e "${CYAN}[3/3] Launching Holographic Desktop HUD Widget...${NC}"
if [ -f "$SCRIPT_DIR/launch_hud_widget.sh" ]; then
  exec "$SCRIPT_DIR/launch_hud_widget.sh" "$@"
else
  echo -e "${RED}[ERROR] launch_hud_widget.sh not found in $SCRIPT_DIR${NC}"
  exit 1
fi
