#!/usr/bin/env bash
# Push-to-talk trigger for the FRIDAY HUD. Bound to Ctrl+Alt+Space as a GNOME custom shortcut.
# Sends one command over the HUD's private control socket; does nothing if the HUD isn't running.
sock="${XDG_RUNTIME_DIR:-/tmp}/friday-hud.sock"
[[ -S "$sock" ]] || exit 0
exec python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(1); s.connect(sys.argv[1]); s.sendall(sys.argv[2].encode())' "$sock" "${1:-ptt}"
