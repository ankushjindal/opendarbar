#!/bin/bash
# Hourly read-later sync: refresh cookies, then pull each feed.
# Each step is isolated; one failing never blocks the others. Always exits 0 so
# launchd does not back off.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/kush/logs/read-later-sync.log"
mkdir -p "$(dirname "$LOG")" "$HOME/.config/read-later"

DIA_PROFILE="$HOME/Library/Application Support/Dia/User Data/Profile 1"
COOKIES="$HOME/.config/read-later/cookies.txt"

step() {  # step <name> <command...> -> echoes "name=ok" or "name=fail(...)"
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "$out" | sed 's/^/    /' >> "$LOG.detail"
    printf '%s' "$(echo "$out" | tail -1 | sed 's/^\[[^]]*\] //')"
  else
    echo "$out" | sed 's/^/    /' >> "$LOG.detail"
    printf '%s=fail: %s' "$name" "$(echo "$out" | tail -1 | cut -c1-120)"
  fi
}

: > "$LOG.detail"
COOK=$(step cookies python3 "$DIR/export-dia-cookies.py" "$DIA_PROFILE" "$COOKIES" youtube.com google.com x.com twitter.com)
YT=$(step youtube-wl "$DIR/youtube-wl.sh" "$@")
XB=$(step x-bookmarks "$DIR/x-bookmarks.sh" "$@")
# bodies for what just arrived, on a budget so one slow site cannot eat the hour
PF=$(step prefetch "$DIR/prefetch.sh" 20 240)
# tags for whatever arrived untagged, five model calls at most
AT=$(step autotag "$DIR/autotag.sh" 5)

echo "[$(date '+%Y-%m-%d %H:%M:%S')] $COOK | $YT | $XB | $PF | $AT" >> "$LOG"
tail -400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
