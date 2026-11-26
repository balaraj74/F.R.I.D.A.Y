#!/usr/bin/env bash
# ==============================================================================
#  F.R.I.D.A.Y. — One-Command Shutdown Script
#  Gracefully terminates:
#    1. Holographic HUD widget
#    2. F.R.I.D.A.Y. Gateway daemon
#    3. Antigravity Claude Proxy
# ==============================================================================

CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'
BOLD='\033[1m'

echo -e "${CYAN}${BOLD}[FRIDAY SHUTDOWN] Terminating active services...${NC}"

# 1. Stop HUD
echo "  Stopping HUD widget..."
pkill -f "electron .*friday-hud" 2>/dev/null || true

# 2. Stop Gateway
echo "  Stopping Gateway daemon..."
if command -v tmux &>/dev/null; then
  tmux kill-session -t friday 2>/dev/null || true
fi
pkill -f "friday gateway" 2>/dev/null || true
pkill -f "node .*friday.mjs gateway" 2>/dev/null || true

# 3. Stop Proxy
echo "  Stopping Antigravity proxy..."
if command -v antigravity-claude-proxy &>/dev/null; then
  antigravity-claude-proxy stop 2>/dev/null || true
elif command -v acc &>/dev/null; then
  acc stop 2>/dev/null || true
fi
pkill -f "antigravity-claude-proxy" 2>/dev/null || true

echo -e "${GREEN}${BOLD}✓ All F.R.I.D.A.Y. services shut down cleanly.${NC}"
