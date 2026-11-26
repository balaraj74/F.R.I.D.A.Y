#!/usr/bin/env bash
# Private web search for FRIDAY (SearXNG) and automations (n8n): settings and data folders.
# The containers themselves start with FRIDAY's INITIALIZE (friday-hud/electron/containers.cjs).
set -euo pipefail
S="$HOME/.friday/searxng/settings.yml"
mkdir -p "$(dirname "$S")" "$HOME/.friday/n8n"
chmod 700 "$HOME/.friday/n8n"
if [[ ! -f "$S" ]]; then
  cat > "$S" <<YAML
# FRIDAY's private search (SearXNG). Only reachable from this machine.
use_default_settings:
  engines:
    keep_only: [google, bing, startpage, mojeek, wikipedia, duckduckgo, brave, github, stackoverflow]
server:
  secret_key: "$(openssl rand -hex 32)"
  limiter: false
  image_proxy: false
search:
  safe_search: 0
  formats: [html, json]
outgoing:
  request_timeout: 6.0
  max_request_timeout: 10.0
engines:
  - name: google
    disabled: false
  - name: bing
    disabled: false
  - name: startpage
    disabled: false
  - name: mojeek
    disabled: false
  - name: wikipedia
    disabled: false
YAML
  # Read by the container's own user; mounted read-only.
  chmod 644 "$S"
fi
echo "Ready. SearXNG and n8n start with FRIDAY's INITIALIZE."
