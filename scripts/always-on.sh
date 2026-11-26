#!/usr/bin/env bash
# Keeps FRIDAY's engine running whether or not the HUD window is open.
#
#   scripts/always-on.sh install     install and start the services (safe to re-run)
#   scripts/always-on.sh status      show what is running
#   scripts/always-on.sh uninstall   stop and remove them (the old "runs only while the app is open" mode)
#
# systemd user services, started at login (and at boot when linger is on), restarted if they crash:
#   friday-proxy       the reasoning engine (antigravity proxy, port 8080)
#   friday-gateway     the gateway (port 18789)
#   friday-whisper     speech to text   (port 18950, CPU)
#   friday-kokoro      voice activity + fallback voice (port 18951)
#   friday-supertonic  FRIDAY's voice, on the GPU when CUDA is installed (port 18952)
#   friday-quickbar    the shake-to-summon bar's helper, with the gateway link kept warm
#   friday-containers  SearXNG and n8n helpers, if they are set up
#
# The HUD then only shows a window: closing it leaves all of this running.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE_DIR="$HOME/.friday"
VOICE_DIR="$STATE_DIR/voice"
MARKER="$STATE_DIR/always-on"
PROXY_VERSION="${FRIDAY_PROXY_VERSION:-2.8.7}"
UNITS=(friday-proxy friday-gateway friday-whisper friday-kokoro friday-supertonic friday-quickbar friday-containers)

say() { printf '%s\n' "$*"; }
# Nothing here is deleted: files go to a trash folder so a mistake is recoverable.
discard() {
  [[ -e "$1" ]] || return 0
  mkdir -p "$STATE_DIR/trash"
  mv "$1" "$STATE_DIR/trash/$(basename "$1").$(date +%s)"
}
warn() { printf 'always-on: %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

gateway_port() {
  node -e '
    try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(c?.gateway?.port || 18789); }
    catch { console.log(18789); }' "$STATE_DIR/friday.json"
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

write_unit() { # name, content from stdin
  cat >"$UNIT_DIR/$1.service"
  say "  wrote $1.service"
}

install_units() {
  command -v systemctl >/dev/null || die "systemctl not found."
  local node_bin port
  node_bin="$(command -v node)" || die "node not found."
  port="$(gateway_port)"
  mkdir -p "$UNIT_DIR" "$VOICE_DIR" "$STATE_DIR/logs"

  # One shared secret for the voice servers. The HUD and the quick bar read it from runtime.json.
  if [[ ! -s "$VOICE_DIR/service.env" ]]; then
    ( umask 077; printf 'FRIDAY_VOICE_TOKEN=%s\n' "$(node -p 'require("crypto").randomBytes(16).toString("hex")')" >"$VOICE_DIR/service.env" )
  fi
  local token
  token="$(sed -n 's/^FRIDAY_VOICE_TOKEN=//p' "$VOICE_DIR/service.env")"
  ( umask 077; node -e '
      const [token] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({token, managed: true, ports: {stt: 18950, kokoro: 18951, supertonic: 18952}}));
    ' "$token" >"$VOICE_DIR/runtime.json" )

  # Reasoning engine.
  write_unit friday-proxy <<EOF
[Unit]
Description=FRIDAY reasoning engine (antigravity proxy)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$REPO
ExecStartPre=-/bin/bash -lc 'bash "$REPO/scripts/patch-antigravity-proxy.sh" $PROXY_VERSION'
# --log keeps the proxy in the foreground; without it "start" detaches and systemd would restart it forever.
ExecStart=/bin/bash -lc 'exec npx -y antigravity-claude-proxy@$PROXY_VERSION start --log'
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF

  # Gateway: keep an existing unit (written by "friday gateway install") and only order it after the proxy.
  if [[ ! -f "$UNIT_DIR/friday-gateway.service" ]]; then
    write_unit friday-gateway <<EOF
[Unit]
Description=FRIDAY gateway
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=$REPO
ExecStart=$node_bin $REPO/dist/index.js gateway --port $port
Environment=FRIDAY_GATEWAY_PORT=$port
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
  fi
  mkdir -p "$UNIT_DIR/friday-gateway.service.d"
  cat >"$UNIT_DIR/friday-gateway.service.d/10-always-on.conf" <<EOF
[Unit]
After=friday-proxy.service
Wants=friday-proxy.service
[Service]
Restart=always
RestartSec=5
# Stop the gateway together with the tool servers it started, so restarts never leave orphans behind.
KillMode=control-group
TimeoutStopSec=25
EOF
  say "  wrote friday-gateway.service.d/10-always-on.conf"

  # Voice. Each part is skipped when it is not installed on this machine.
  local whisper_bin="$VOICE_DIR/whisper.cpp/build/bin/whisper-server"
  local whisper_model="$VOICE_DIR/whisper.cpp/models/ggml-small.en.bin"
  local whisper_vad="$VOICE_DIR/whisper.cpp/models/ggml-silero-v5.1.2.bin"
  if [[ -x "$whisper_bin" && -f "$whisper_model" ]]; then
    local vad_args=""
    [[ -f "$whisper_vad" ]] && vad_args="--vad --vad-model $whisper_vad"
    write_unit friday-whisper <<EOF
[Unit]
Description=FRIDAY speech to text (whisper.cpp)
[Service]
Type=simple
ExecStart=$whisper_bin -m $whisper_model --host 127.0.0.1 --port 18950 -t 8 -bs 1 -bo 1 -fa $vad_args
Nice=5
Restart=on-failure
RestartSec=15
[Install]
WantedBy=default.target
EOF
  fi

  local node_dir="$VOICE_DIR/node"
  if [[ -d "$node_dir/node_modules/kokoro-js" ]]; then
    cp "$REPO/friday-hud/voice/voice-server.mjs" "$node_dir/voice-server.mjs"
    write_unit friday-kokoro <<EOF
[Unit]
Description=FRIDAY voice activity and fallback voice (Kokoro)
[Service]
Type=simple
WorkingDirectory=$node_dir
EnvironmentFile=$VOICE_DIR/service.env
Environment=FRIDAY_VOICE_PORT=18951
Environment=FRIDAY_VAD_MODEL=$VOICE_DIR/models/silero_vad.onnx
ExecStart=$node_bin $node_dir/voice-server.mjs
Restart=on-failure
RestartSec=15
[Install]
WantedBy=default.target
EOF
  fi

  local st_py="$VOICE_DIR/supertonic/venv/bin/python"
  if [[ -x "$st_py" ]]; then
    write_unit friday-supertonic <<EOF
[Unit]
Description=FRIDAY voice (Supertonic, GPU when CUDA is available)
[Service]
Type=simple
EnvironmentFile=$VOICE_DIR/service.env
Environment=FRIDAY_SUPERTONIC_PORT=18952
ExecStart=$st_py $REPO/friday-hud/voice/supertonic-server.py
Restart=on-failure
RestartSec=15
[Install]
WantedBy=default.target
EOF
  fi

  # Quick bar helper: resident, with the gateway connection kept warm.
  write_unit friday-quickbar <<EOF
[Unit]
Description=FRIDAY quick bar helper
After=friday-gateway.service
Wants=friday-gateway.service
[Service]
Type=simple
Environment=FRIDAY_QUICKBAR_RESIDENT=1
ExecStart=$node_bin $REPO/quickbar/daemon/daemon.mjs
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF

  # Search and automation helpers (Docker). Not started when Docker is missing or they are not set up.
  write_unit friday-containers <<EOF
[Unit]
Description=FRIDAY helper containers (SearXNG, n8n)
After=friday-gateway.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$node_bin -e "require('$REPO/friday-hud/electron/containers.cjs').startContainers().then(r => console.log('started', r.join(',') || 'none'))"
[Install]
WantedBy=default.target
EOF
}

# A gateway or proxy started by hand (tmux) would hold the ports and make systemd's copy fail.
hand_over_from_tmux() {
  command -v tmux >/dev/null || return 0
  for s in friday friday-proxy; do
    if tmux has-session -t "$s" 2>/dev/null; then
      say "  stopping the manually started '$s' session so systemd can take over"
      tmux kill-session -t "$s" 2>/dev/null || true
    fi
  done
  # The proxy can also be a loose process left by an earlier start; it would hold port 8080.
  local pid
  systemctl --user stop friday-proxy.service 2>/dev/null || true
  pid="$(ss -ltnpH 'sport = :8080' 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  if [[ -n "$pid" ]] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q antigravity-claude-proxy; then
    say "  stopping the loose proxy process ($pid) so systemd can take over"
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
}

cmd_install() {
  say "Installing always-on FRIDAY services..."
  install_units
  date -u +%FT%TZ >"$MARKER"
  systemctl --user daemon-reload
  hand_over_from_tmux
  local enabled=()
  for u in "${UNITS[@]}"; do
    [[ -f "$UNIT_DIR/$u.service" ]] && enabled+=("$u.service")
  done
  systemctl --user enable "${enabled[@]}" >/dev/null 2>&1 || warn "could not enable some services"
  # Voice ports held by a running HUD are freed the next time the HUD restarts; the units keep retrying.
  systemctl --user restart "${enabled[@]}" 2>&1 | sed 's/^/  /' || true
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable linger: services start at login, not at boot"
  say "Waiting for the gateway..."
  local port i
  port="$(gateway_port)"
  for i in $(seq 1 90); do port_up "$port" && break; sleep 1; done
  port_up "$port" && say "Gateway is up on port $port." || warn "gateway is not answering yet; check: scripts/always-on.sh status"
  say "Done. Closing the HUD no longer stops FRIDAY. Remove with: scripts/always-on.sh uninstall"
}

cmd_status() {
  for u in "${UNITS[@]}"; do
    [[ -f "$UNIT_DIR/$u.service" ]] || continue
    printf '%-20s %s\n' "$u" "$(systemctl --user is-active "$u.service" 2>/dev/null || true)"
  done
  local port
  port="$(gateway_port)"
  for pair in "gateway:$port" "proxy:8080" "whisper:18950" "voice:18952"; do
    port_up "${pair#*:}" && printf '%-20s listening\n' "port ${pair#*:} (${pair%%:*})" || printf '%-20s closed\n' "port ${pair#*:} (${pair%%:*})"
  done
  [[ -f "$MARKER" ]] && say "always-on marker: present" || say "always-on marker: absent"
}

cmd_uninstall() {
  for u in "${UNITS[@]}"; do
    systemctl --user disable --now "$u.service" >/dev/null 2>&1 || true
    [[ "$u" == friday-gateway ]] || discard "$UNIT_DIR/$u.service"
  done
  discard "$UNIT_DIR/friday-gateway.service.d/10-always-on.conf"
  discard "$MARKER"
  discard "$VOICE_DIR/runtime.json"
  systemctl --user daemon-reload
  say "Always-on services removed. FRIDAY starts and stops with the HUD again. (The gateway unit written by"
  say "'friday gateway install' was only disabled, not deleted. Removed files are in $STATE_DIR/trash.)"
}

case "${1:-}" in
  install) cmd_install ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) sed -n 2,20p "$0"; exit 1 ;;
esac
