#!/usr/bin/env bash
# Install the fleet ops layer: symlink scripts into ~/kai/, install systemd user units.
# Idempotent. Run from the repo's fleet/ dir.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
KAI=$HOME/kai
UNITS=$HOME/.config/systemd/user
mkdir -p "$KAI/hooks" "$KAI/logs" "$KAI/state" "$UNITS"

ln -sf "$HERE/fleet-ctl"          "$KAI/fleet-ctl"
ln -sf "$HERE/fleet-watchdog.sh"  "$KAI/fleet-watchdog.sh"
ln -sf "$HERE/creds-guard.sh"     "$KAI/refresh-sons-creds.sh"
ln -sf "$HERE/tg-reply-guard.sh"  "$KAI/hooks/tg-reply-guard.sh"
chmod +x "$HERE"/fleet-ctl "$HERE"/*.sh

for u in "$HERE"/systemd/*; do cp "$u" "$UNITS/"; done
systemctl --user daemon-reload
systemctl --user enable --now fleet-watchdog.timer
systemctl --user enable fleet-restore.service
echo "installed. Next: registry.json + fleetRoot in kushbot.json + Stop hook in settings.json (see README)."
