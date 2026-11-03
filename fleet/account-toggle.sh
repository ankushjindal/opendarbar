#!/usr/bin/env bash
# account-toggle.sh — flip the whole server fleet between two Anthropic accounts.
#
# WHY THIS EXISTS: Claude Code has NO native multi-account switch. `/login`
# always overwrites the single ~/.claude/.credentials.json; `/status` only
# *shows* the current account; there is no `/account` command. Our fleet already
# shares ONE active grant (every son's .credentials.json symlinks to parent's
# /home/owner/.claude/.credentials.json). So "toggle accounts" = swap which
# stored grant is that active shared file, then re-link the sons.
#
# MODEL:
#   ~/.claude/creds-store/account-<name>.json   the real grants (one per account)
#   ~/.claude/active-account                     text: which one is live
#   ~/.claude/.credentials.json                  a COPY of the active grant
#                                                (sons symlink to this)
# The creds-guard (refresh-sons-creds.sh) keeps the active store fresh: when a
# session refreshes and writes new rotating tokens into .credentials.json, the
# guard copies them back into creds-store/account-<active>.json so toggling away
# and back never restores a stale (already-rotated) grant.
#
# CAVEAT (Claude Code limitation, not ours): a *running* session holds its token
# in memory and only re-reads the file on refresh/401. So a toggle switches NEW
# sessions instantly; LIVE sessions adopt the other account only after a restart
# (fleet-ctl start <agent> re-reads the file). There is no true in-place hot-swap.
#
# Usage:  account-toggle.sh <name>     e.g. account-toggle.sh personal
#         account-toggle.sh            (no arg = show status + available accounts)
set -uo pipefail

B=/home/owner
CLA="$B/.claude"
STORE="$CLA/creds-store"
LIVE="$CLA/.credentials.json"
ACTIVE_FLAG="$CLA/active-account"
GUARD="$B/kai/refresh-sons-creds.sh"

exp_min() { local f="$1"; local e; e=$(jq -r '.claudeAiOauth.expiresAt // 0' "$f" 2>/dev/null || echo 0); echo $(( (e - $(date +%s%3N)) / 60000 )); }
sub_type() { jq -r '.claudeAiOauth.subscriptionType // "?"' "$1" 2>/dev/null || echo "?"; }

show_status() {
  local active; active=$(cat "$ACTIVE_FLAG" 2>/dev/null || echo "unknown")
  echo "active account : $active"
  [ -f "$LIVE" ] && echo "live grant     : $(sub_type "$LIVE"), expires in $(exp_min "$LIVE") min"
  echo "stored accounts:"
  if [ -d "$STORE" ]; then
    for f in "$STORE"/account-*.json; do
      [ -e "$f" ] || { echo "  (none — capture with /login then account-capture)"; break; }
      local n; n=$(basename "$f" .json | sed 's/^account-//')
      echo "  - $n ($(sub_type "$f"), $(exp_min "$f") min)$( [ "$n" = "$active" ] && echo '  <- active' )"
    done
  else
    echo "  (creds-store missing)"
  fi
}

[ $# -eq 0 ] && { show_status; exit 0; }

target="$1"
src="$STORE/account-$target.json"
[ -f "$src" ] || { echo "ERROR: no stored account '$target' at $src"; echo; show_status; exit 1; }

# Validity note: an expired ACCESS token is usually still recoverable — the first
# session using it refreshes via the (longer-lived) refresh token. Only warn; a
# truly-dead refresh token surfaces as a /login prompt, which is recoverable.
tmin=$(exp_min "$src")
if [ "$tmin" -lt 1 ]; then
  echo "WARN: stored grant '$target' access-token expired $(( -tmin ))min ago."
  echo "      Switching anyway — first session will try to refresh it. If that"
  echo "      fails (refresh token also dead), you'll get a /login prompt."
fi

# Swap: copy target grant into the live shared file, mark active, re-link sons.
cp "$src" "$LIVE" && chmod 600 "$LIVE"
echo "$target" > "$ACTIVE_FLAG"
echo "switched active account -> $target ($(sub_type "$LIVE"), $(exp_min "$LIVE") min)"

# Re-link every son to the freshened shared file.
[ -x "$GUARD" ] && "$GUARD" >/dev/null 2>&1 && echo "sons re-linked to shared grant"

echo
echo "NOTE: new sessions use '$target' immediately."
echo "      LIVE sessions keep their in-memory token until restarted"
echo "      (fleet-ctl start <agent> to move a running session to '$target')."
