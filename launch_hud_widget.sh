#!/usr/bin/env bash
#
# launch_hud_widget.sh — Launch FRIDAY Sci-Fi Holographic Desktop Widget on Linux
#

set -euo pipefail

# Crucial: Unset VS Code / environment override so Electron runs as GUI app, not Node
unset ELECTRON_RUN_AS_NODE

# Auto-detect Display and Authority (supports Wayland Xwayland and native X11)
if [[ -z "${DISPLAY:-}" ]]; then
  for s in /tmp/.X11-unix/X*; do
    if [[ -S "$s" ]]; then
      disp_num="${s##*/X}"
      if [[ -n "$disp_num" ]]; then
        export DISPLAY=":$disp_num"
      fi
    fi
  done
  export DISPLAY="${DISPLAY:-:0}"
fi

if [[ -z "${XAUTHORITY:-}" ]]; then
  for auth in /run/user/$(id -u)/.mutter-Xwaylandauth* "/run/user/$(id -u)/gdm/Xauthority" "/run/user/$(id -u)/.Xauthority" "$HOME/.Xauthority"; do
    if [[ -f "$auth" ]]; then
      export XAUTHORITY="$auth"
      break
    fi
  done
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUD_DIR="$SCRIPT_DIR/friday-hud"
cd "$HUD_DIR"

# Ensure dist exists
if [[ ! -f "$HUD_DIR/dist/index.html" ]]; then
  echo "Building FRIDAY HUD..."
  pnpm build
fi

# Locate Electron binary portably
if [[ -x "$HUD_DIR/node_modules/.bin/electron" ]]; then
  ELECTRON_BIN="$HUD_DIR/node_modules/.bin/electron"
elif [[ -x "$SCRIPT_DIR/node_modules/.bin/electron" ]]; then
  ELECTRON_BIN="$SCRIPT_DIR/node_modules/.bin/electron"
else
  ELECTRON_BIN="npx --yes electron"
fi

echo "Launching FRIDAY Holographic Desktop Widget on screen $DISPLAY..."
exec $ELECTRON_BIN \
  --no-sandbox \
  --enable-transparent-visuals \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --enable-gpu-rasterization \
  --enable-zero-copy \
  --enable-features=CanvasOopRasterization,VaapiVideoDecoder \
  --ignore-gpu-blocklist \
  --js-flags="--max-old-space-size=2048" \
  "$HUD_DIR" \
  "$@"

