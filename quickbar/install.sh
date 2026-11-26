#!/usr/bin/env bash
# Installs the FRIDAY Quick Bar (GNOME Shell extension + small background daemon).
#
#   quickbar/install.sh              install and enable
#   quickbar/install.sh --uninstall  disable and remove the extension link (keeps your data)
#
# Needs GNOME Shell 49 or newer. Nothing runs until you shake the mouse or press the shortcut.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
UUID="friday-quickbar@friday.balaraj74"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
CONFIG="$HOME/.friday/quickbar.json"

say() { printf '%s\n' "$*"; }
die() { printf 'quickbar: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  gnome-extensions disable "$UUID" 2>/dev/null || true
  [[ -L "$EXT_DIR" ]] && rm "$EXT_DIR"
  pkill -f "quickbar/daemon/daemon.mjs" 2>/dev/null || true
  say "Quick bar removed. Your ~/.friday/quickbar.json was kept."
  exit 0
fi

command -v gnome-shell >/dev/null || die "GNOME Shell not found. The quick bar only supports GNOME."
SHELL_MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
(( SHELL_MAJOR >= 49 )) || die "GNOME Shell $SHELL_MAJOR is too old (need 49 or newer)."

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "node not found. Run the main install.sh first."
(( $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') >= 22 )) || die "Node 22 or newer is required."

missing=()
for tool in ffmpeg pw-record paplay glib-compile-schemas gnome-extensions; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  die "missing tools: ${missing[*]}  (try: sudo apt install ffmpeg pipewire-bin pulseaudio-utils libglib2.0-bin)"
fi

glib-compile-schemas "$HERE/extension/schemas"

# The extension is a link to the repository, so updating FRIDAY updates the quick bar too.
mkdir -p "$(dirname "$EXT_DIR")" "$HOME/.friday"
ln -sfn "$HERE/extension" "$EXT_DIR"

# Tell the extension where the daemon lives. Keep any settings that are already there.
node - "$CONFIG" "$REPO" "$NODE_BIN" <<'JS'
const fs = require('fs');
const [file, repoDir, node] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
fs.writeFileSync(file, JSON.stringify({ ...cfg, repoDir, node }, null, 2) + '\n', { mode: 0o600 });
JS

gnome-extensions enable "$UUID" 2>/dev/null || true

say "Quick bar installed."
if gnome-extensions info "$UUID" 2>/dev/null | grep -q "State: ACTIVE\|State: ENABLED"; then
  say "It is active. Shake the mouse, or press Ctrl+Alt+Space, to try it."
else
  say "One more step: log out and back in once so GNOME loads the extension (Wayland cannot reload it live)."
  say "Then shake the mouse, hold F + Space, or press Ctrl+Alt+Space."
fi
