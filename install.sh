#!/usr/bin/env bash
# ==============================================================================
#  FRIDAY installer for Ubuntu / Debian desktops (X11 or Wayland).
#
#  One line:
#    git clone --depth 1 https://github.com/balaraj74/F.R.I.D.A.Y.git ~/F.R.I.D.A.Y && ~/F.R.I.D.A.Y/install.sh
#
#  What it does (safe to re-run; never overwrites an existing ~/.friday config or ~/friday):
#    1. System packages (git, build tools, python3-venv, ffmpeg, tmux, cmake)  [asks for sudo]
#    2. Node.js 22 (via nvm, no sudo) and pnpm
#    3. Installs and builds FRIDAY (gateway + HUD)
#    4. Brain: antigravity-claude-proxy 2.8.7 with the 64k output limit
#    5. Fresh config (random gateway token) and a personal workspace in ~/friday
#    6. Local voice: whisper.cpp (speech-to-text) + Supertonic/Kokoro (voice), GPU if NVIDIA
#    7. Verifies the job engine, design tooling and health monitor; success only if all three work
#    8. Optional auto-start at login/boot (systemd user unit, only with --autostart)
#
#  Options:  --name "Rahul"   --address "Boss"   --no-voice   --yes (no questions)
#            --autostart (register a systemd --user unit under ~/.config/systemd/user)
#            --always-on (keep the gateway, proxy and voice running even when the HUD is closed)
#            --verify-only (skip steps 1-6; only run the checks and the optional auto-start)
# ==============================================================================
set -euo pipefail

REPO_URL="${FRIDAY_REPO:-https://github.com/balaraj74/F.R.I.D.A.Y.git}"
BRANCH="${FRIDAY_BRANCH:-main}"
DIR="${FRIDAY_DIR:-$HOME/F.R.I.D.A.Y}"
PROXY_VERSION="2.8.7"
NODE_MAJOR=22
NAME=""
ADDRESS=""
WITH_VOICE=1
ASSUME_YES=0
AUTOSTART=0
ALWAYS_ON=0
VERIFY_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --address) ADDRESS="$2"; shift 2 ;;
    --no-voice) WITH_VOICE=0; shift ;;
    --autostart) AUTOSTART=1; shift ;;
    --always-on) ALWAYS_ON=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n 2,21p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

C='\033[0;36m'; G='\033[0;32m'; A='\033[0;33m'; R='\033[0;31m'; B='\033[1m'; N='\033[0m'
step() { echo -e "\n${C}${B}==> $*${N}"; }
ok()   { echo -e "  ${G}✓${N} $*"; }
warn() { echo -e "  ${A}!${N} $*"; }
die()  { echo -e "${R}✗ $*${N}" >&2; exit 1; }
ask()  { # ask "Question" default -> echoes answer
  local q="$1" d="$2" a=""
  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then echo "$d"; return; fi
  read -r -p "  $q [$d]: " a </dev/tty || true
  echo "${a:-$d}"
}

# Runs one component check from the FRIDAY directory; prints the output only on failure.
check_component() { # check_component "<name>" <command...>
  local name="$1" out; shift
  if out="$(cd "$DIR" && "$@" 2>&1)"; then
    ok "$name"
    return 0
  fi
  echo -e "  ${R}✗${N} $name failed" >&2
  printf '%s\n' "$out" | tail -5 | sed 's/^/      /' >&2
  return 1
}

# Succeeds only if the job engine, design tooling and health monitor are all present and start.
verify_components() {
  local failed=() list=""
  [[ -f "$DIR/friday.mjs" ]] || die "friday.mjs not found in $DIR; the build is incomplete."
  check_component "job engine (friday jobs)" node friday.mjs jobs --help || failed+=("job engine")
  check_component "design tooling (friday design)" node friday.mjs design --help || failed+=("design tooling")
  check_component "health monitor (friday jobs health)" node friday.mjs jobs health || failed+=("health monitor")
  if [[ ${#failed[@]} -gt 0 ]]; then
    for c in "${failed[@]}"; do list="${list:+$list, }$c"; done
    die "Install failed. Component(s) not working: $list."
  fi
}

autostart_error() { echo -e "${R}✗ Auto-start registration failed: $*${N}" >&2; }

# Registers a systemd --user unit that starts FRIDAY after login/boot. Returns non-zero on failure.
register_autostart() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" unit
  unit="$unit_dir/friday.service"
  command -v systemctl >/dev/null 2>&1 || { autostart_error "systemctl not found."; return 1; }
  mkdir -p "$unit_dir" || { autostart_error "cannot create $unit_dir."; return 1; }
  # In systemd units "$$" is a literal "$".
  cat >"$unit" <<EOF || { autostart_error "cannot write $unit."; return 1; }
[Unit]
Description=FRIDAY personal AI companion
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=/bin/bash -lc 'if [ -s "\$\$HOME/.nvm/nvm.sh" ]; then . "\$\$HOME/.nvm/nvm.sh"; fi; exec pnpm start:all'
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  if ! systemctl --user daemon-reload || ! systemctl --user enable friday.service >/dev/null; then
    autostart_error "systemctl --user could not enable friday.service (unit file: $unit)."
    return 1
  fi
  # Lets the user service start at boot without a login session; login start works without it.
  loginctl enable-linger "$USER" >/dev/null 2>&1 || warn "could not enable linger; FRIDAY will start at your next login, not at boot"
  ok "auto-start registered ($unit)"
}

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux (Ubuntu/Debian). See README for other systems."
[[ $EUID -ne 0 ]] || die "Run as your normal user, not root (it will ask for sudo when needed)."

echo -e "${C}${B}"
cat <<'EOF'
   _____ ____  ___ ____    _ __   __
  |  ___|  _ \|_ _|  _ \  / \\ \ / /
  | |_  | |_) || || | | |/ _ \\ V /
  |  _| |  _ < | || |_| / ___ \| |
  |_|   |_| \_\___|____/_/   \_\_|    installer
EOF
echo -e "${N}"

if [[ $VERIFY_ONLY -eq 1 ]]; then
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  step "Verify components"
  verify_components
  if [[ $AUTOSTART -eq 1 ]]; then
    step "Auto-start"
    register_autostart || exit 1
  fi
  echo -e "\n${G}${B}All components verified.${N}"
  exit 0
fi

# ------------------------------------------------------------------------------
step "1/6  System packages"
PKGS=(git curl ca-certificates build-essential cmake python3 python3-venv python3-pip ffmpeg tmux)
if command -v apt-get >/dev/null; then
  MISSING=()
  for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "  Installing: ${MISSING[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y -qq "${MISSING[@]}"
  fi
  ok "system packages ready"
else
  warn "apt-get not found: make sure these are installed: ${PKGS[*]}"
fi

# ------------------------------------------------------------------------------
step "2/6  Node.js $NODE_MAJOR and pnpm"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'; }
if ! node_ok; then
  export NVM_DIR="$HOME/.nvm"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    git clone -q --depth 1 --branch v0.40.3 https://github.com/nvm-sh/nvm.git "$NVM_DIR"
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR" >/dev/null
  nvm alias default "$NODE_MAJOR" >/dev/null
fi
node_ok || die "Node.js 22.19+ is required (found $(node -v 2>/dev/null || echo none))."
ok "node $(node -v)"
if ! command -v pnpm >/dev/null; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10.23.0 >/dev/null
fi
command -v pnpm >/dev/null || die "pnpm could not be installed."
ok "pnpm $(pnpm -v)"

# ------------------------------------------------------------------------------
step "3/6  FRIDAY source and build"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ -n "$SELF_DIR" && -f "$SELF_DIR/package.json" ]] && grep -q '"name": "friday"' "$SELF_DIR/package.json"; then
  DIR="$SELF_DIR"
elif [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull -q --ff-only || warn "could not update $DIR (local changes?); using it as is"
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"
ok "source in $DIR"
echo "  Installing dependencies (a few minutes the first time)..."
pnpm install --frozen-lockfile >/tmp/friday-install.log 2>&1 || { tail -20 /tmp/friday-install.log; die "pnpm install failed (full log: /tmp/friday-install.log)"; }
echo "  Building FRIDAY..."
pnpm build >/tmp/friday-build.log 2>&1 || { tail -20 /tmp/friday-build.log; die "build failed (log: /tmp/friday-build.log)"; }
(cd friday-hud && pnpm build >/tmp/friday-hud-build.log 2>&1) || { tail -20 /tmp/friday-hud-build.log; die "HUD build failed (log: /tmp/friday-hud-build.log)"; }
ok "gateway and HUD built"

# ------------------------------------------------------------------------------
step "4/6  Brain (antigravity proxy $PROXY_VERSION)"
npx -y "antigravity-claude-proxy@$PROXY_VERSION" --help >/dev/null 2>&1 || true
bash scripts/patch-antigravity-proxy.sh "$PROXY_VERSION" >/dev/null && ok "proxy ready (64k output limit)"

# ------------------------------------------------------------------------------
step "5/6  Your config and workspace"
CFG_DIR="$HOME/.friday"
CFG="$CFG_DIR/friday.json"
WS="$HOME/friday"
mkdir -p "$CFG_DIR/logs"
[[ -n "$NAME" ]] || NAME="$(ask "What's your name?" "$(getent passwd "$USER" | cut -d: -f5 | cut -d, -f1 | awk '{print $1}')")"
[[ -n "$NAME" ]] || NAME="$USER"
[[ -n "$ADDRESS" ]] || ADDRESS="$(ask "What should FRIDAY call you?" "Boss")"
TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"

if [[ -f "$CFG" ]]; then
  ok "keeping existing $CFG"
else
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  cat >"$CFG" <<EOF
{
  "gateway": { "mode": "local", "port": 18789, "bind": "loopback", "auth": { "token": "$TOKEN" } },
  "models": {
    "providers": {
      "antigravity-proxy": {
        "baseUrl": "http://localhost:8080",
        "api": "anthropic-messages",
        "apiKey": "antigravity-proxy",
        "models": [
          { "id": "gemini-4-hydrogen-sonar", "name": "Gemini 4 Hydrogen Sonar", "reasoning": true, "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 64000 },
          { "id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash Lite", "reasoning": false, "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 64000 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "$WS",
      "userTimezone": "$TZ_NAME",
      "model": { "primary": "antigravity-proxy/gemini-4-hydrogen-sonar", "fallbacks": ["antigravity-proxy/gemini-3.5-flash-lite"] },
      "fastModel": "antigravity-proxy/gemini-3.5-flash-lite"
    }
  }
}
EOF
  chmod 600 "$CFG"
  ok "created $CFG"
fi

if [[ -e "$WS/SOUL.md" ]]; then
  ok "keeping existing workspace $WS"
else
  mkdir -p "$WS/memory"
  for f in SOUL.md IDENTITY.md USER.md; do
    sed -e "s/{{NAME}}/$NAME/g" -e "s/{{ADDRESS}}/$ADDRESS/g" -e "s#{{TIMEZONE}}#$TZ_NAME#g" \
      "templates/friday-workspace/$f" >"$WS/$f"
  done
  ok "workspace $WS (FRIDAY will call you \"$ADDRESS\")"
fi
[[ -f "$CFG_DIR/voice.json" ]] || echo '{ "ttsModel": "supertonic", "supertonicVoice": "F1", "supertonicSpeed": 0.9 }' >"$CFG_DIR/voice.json"

# ------------------------------------------------------------------------------
step "6/6  Local voice"
if [[ $WITH_VOICE -eq 1 ]]; then
  echo "  Downloading speech models (about 1.5 GB, more with an NVIDIA GPU)..."
  bash friday-hud/voice/setup-local.sh >/tmp/friday-voice.log 2>&1 \
    && ok "voice ready ($(command -v nvidia-smi >/dev/null && echo 'NVIDIA GPU' || echo 'CPU'))" \
    || warn "voice setup failed (log: /tmp/friday-voice.log). FRIDAY still works; re-run: bash $DIR/friday-hud/voice/setup-local.sh"
else
  warn "skipped (--no-voice). Later: bash $DIR/friday-hud/voice/setup-local.sh"
fi

# Desktop launcher
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
cat >"$APPS/friday.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=FRIDAY
Comment=Your personal AI companion
Exec=bash -lc 'cd "$DIR" && pnpm start:all'
Icon=$DIR/friday-hud/public/friday-icon.png
Terminal=false
Categories=Utility;
EOF
ok "added FRIDAY to your app menu"

# ------------------------------------------------------------------------------
# Quick bar: shake the mouse to ask FRIDAY about the screen. GNOME only; a failure here never fails the install.
if command -v gnome-shell >/dev/null 2>&1; then
  step "Quick bar (shake-to-summon, GNOME)"
  bash "$DIR/quickbar/install.sh" || warn "quick bar not installed (see above); FRIDAY itself is fine"
fi
step "Verifying job engine, design tooling and health monitor"
verify_components
if [[ $AUTOSTART -eq 1 ]]; then
  step "Auto-start"
  register_autostart || die "FRIDAY is installed, but auto-start registration failed (see above). Fix it and re-run with --autostart."
fi

if [[ $ALWAYS_ON -eq 1 ]]; then
  step "Always-on services"
  bash "$DIR/scripts/always-on.sh" install || warn "always-on services not installed (see above); FRIDAY itself is fine"
fi
echo -e "\n${G}${B}FRIDAY is installed.${N}\n"
echo -e "${B}One more step: connect the brain to a Google account (opens a browser):${N}"
echo -e "  npx -y antigravity-claude-proxy@$PROXY_VERSION accounts add\n"
echo -e "${B}Then start FRIDAY:${N} open ${B}FRIDAY${N} from the app menu, or run:"
echo -e "  cd $DIR && pnpm start:all\n"
