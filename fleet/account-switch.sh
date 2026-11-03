#!/usr/bin/env bash
# account-switch.sh <agent> <token-path> <label> <chat_id>
#
# Per-session account switch on server. Relaunches <agent> RESUMING its current
# session, injecting the target account's setup-token so env-var precedence beats
# the shared .credentials.json — WITHOUT repointing the shared oat-active symlink
# (that symlink is fleet-wide; a single-son switch must not drag the whole fleet).
#
# Replaces the old server.ts respawn that ran the Mac-only `kc`/`dc` aliases via
# `zsh -ic` — which don't exist on server, so the pane died on every switch
# (the 2026-07-09 "account switch went dark" + 2026-07-10 forwarded-/account
# incidents). This delegates to fleet-ctl start, which has the correct server
# relaunch (session capture, resume, verify-up).
#
# Quiet by design: sets the watchdog maint flag + the bot's quiet-restart marker
# so neither the red "going dark" nor the green "attached" notice fires. Drops an
# account-switched marker the successor consumes on attach to post a single
# "✅ back on <label>, conversation resumed" confirmation. Detached (setsid nohup)
# so it survives the pane kill that fleet-ctl start performs.
set -uo pipefail
AGENT="${1:?usage: account-switch.sh <agent> <token-path> <label> <chat_id>}"
TOKPATH="${2:?token path}"
LABEL="${3:?label}"
CHAT="${4:?chat_id}"
B=/home/owner
LOG="$B/kai/logs/account-switch.log"
REG="$B/.claude/channels/fleet/registry.json"
mkdir -p "$(dirname "$LOG")" "$B/kai/state"

[ -r "$TOKPATH" ] || { echo "$(date -u +%FT%TZ) ABORT $AGENT: no readable token at $TOKPATH" >> "$LOG"; exit 1; }
HOME_DIR=$(jq -r --arg n "$AGENT" '.agents[] | select(.name == $n) | .home // empty' "$REG" 2>/dev/null || true)
[ -n "$HOME_DIR" ] || { echo "$(date -u +%FT%TZ) ABORT $AGENT: no home in registry" >> "$LOG"; exit 1; }

now=$(date +%s)
# quiet markers: watchdog maintenance gate + lifecycle-notice suppression
echo $(( now + 180 )) > "$B/kai/state/maint-$AGENT"
echo $(( now + 180 )) > "$HOME_DIR/.claude/channels/telegram/quiet-restart" 2>/dev/null || true
# confirmation marker the successor reads on attach (then deletes)
printf '{"label":"%s","chat_id":"%s"}\n' "$LABEL" "$CHAT" \
  > "$HOME_DIR/.claude/channels/telegram/account-switched" 2>/dev/null || true

DELAY="${ACCOUNT_SWITCH_DELAY:-3}"
setsid nohup bash -c "
  sleep $DELAY
  echo \"\$(date -u +%FT%TZ) account-switch firing: $AGENT -> $LABEL (token $TOKPATH)\" >> '$LOG'
  FLEETCTL_OAT_OVERRIDE='$TOKPATH' '$B/kai/fleet-ctl' start '$AGENT' >> '$LOG' 2>&1
  rc=\$?
  echo \"\$(date -u +%FT%TZ) account-switch done: $AGENT -> $LABEL rc=\$rc\" >> '$LOG'
  rm -f \"$B/kai/state/maint-$AGENT\"
  if [ \$rc -ne 0 ]; then
    # relaunch failed — remove the confirmation marker so no false 'back on' fires
    rm -f \"$HOME_DIR/.claude/channels/telegram/account-switched\"
  fi
" </dev/null >>"$LOG" 2>&1 &
disown 2>/dev/null || true
echo "account-switch scheduled: $AGENT -> $LABEL in ${DELAY}s (detached)"
