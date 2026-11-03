#!/usr/bin/env bash
# gateway/install.sh — install + harden CLIProxyAPI on this machine (Mac or Linux).
# Idempotent: safe to re-run. Does NOT do provider logins (interactive, see README).
#
#   ./install.sh          install/upgrade + harden config + (re)start service
#   ./install.sh --check  report state only, change nothing
set -euo pipefail

CHECK_ONLY="${1:-}"
OS="$(uname -s)"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# ---------- locate / install the binary + config ----------
if [ "$OS" = "Darwin" ]; then
  CONF="/opt/homebrew/etc/cliproxyapi.conf"
  BIN="/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi"
  if [ ! -x "$BIN" ]; then
    [ "$CHECK_ONLY" = "--check" ] && { say "cliproxyapi: NOT INSTALLED"; exit 1; }
    brew install cliproxyapi
  fi
  START_CMD="brew services restart cliproxyapi"
else
  # Linux (server): official one-click installer → ~/cliproxyapi + USER systemd unit.
  CONF="$HOME/cliproxyapi/config.yaml"
  BIN="$HOME/cliproxyapi/cli-proxy-api"
  if [ ! -x "$BIN" ]; then
    [ "$CHECK_ONLY" = "--check" ] && { say "cliproxyapi: NOT INSTALLED"; exit 1; }
    curl -fsSL https://raw.githubusercontent.com/router-for-me/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash
  fi
  systemctl --user enable cliproxyapi.service >/dev/null 2>&1 || true
  START_CMD="systemctl --user restart cliproxyapi.service"
fi
[ -f "$CONF" ] || die "config not found at $CONF"

# ---------- client key ----------
KEYFILE="$HOME/.cli-proxy-api/client-key.txt"
mkdir -p "$HOME/.cli-proxy-api" && chmod 700 "$HOME/.cli-proxy-api"
if [ ! -s "$KEYFILE" ]; then
  [ "$CHECK_ONLY" = "--check" ] && say "client key: MISSING" || {
    openssl rand -hex 24 > "$KEYFILE"; chmod 600 "$KEYFILE"; say "client key: generated"
  }
else
  say "client key: present"
fi

# ---------- harden config (localhost bind + our key, drop placeholders) ----------
if [ "$CHECK_ONLY" = "--check" ]; then
  grep -q 'host: "127.0.0.1"' "$CONF" && say "bind: 127.0.0.1 OK" || say "bind: NOT localhost — RUN INSTALL"
  grep -q 'your-api-key' "$CONF" && say "api-keys: PLACEHOLDERS PRESENT — RUN INSTALL" || say "api-keys: OK"
  exit 0
fi

python3 - "$CONF" "$KEYFILE" <<'EOF'
import re, sys
conf, keyfile = sys.argv[1], sys.argv[2]
key = open(keyfile).read().strip()
s = open(conf).read()
s = re.sub(r'^host: ""', 'host: "127.0.0.1"', s, count=1, flags=re.M)
# replace the whole api-keys block (placeholders or stale key) with ours
s = re.sub(r'^api-keys:\n(  - ".*"\n)+', f'api-keys:\n  - "{key}"\n', s, count=1, flags=re.M)
open(conf, 'w').write(s)
EOF
chmod 600 "$CONF" 2>/dev/null || sudo chmod 600 "$CONF"
say "config: hardened (127.0.0.1 bind, single client key)"

# ---------- (re)start ----------
eval "$START_CMD"
sleep 3
if curl -s -m 5 -o /dev/null -H "x-api-key: $(cat "$KEYFILE")" "http://127.0.0.1:8317/v1/models"; then
  say "service: UP on 127.0.0.1:8317"
else
  die "service did not come up — check logs"
fi

say ""
say "NEXT (interactive, once per machine — see README.md):"
say "  $BIN -codex-device-login    # GPT via ChatGPT account (device flow, phone-friendly)"
say "  $BIN -xai-login -no-browser # Grok via xAI account (device flow)"
