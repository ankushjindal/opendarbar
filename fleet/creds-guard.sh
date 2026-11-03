#!/usr/bin/env bash
# creds symlink guard (v3, 2026-07-04) — was "copy parent creds to sons every 6h".
#
# WHY THE COPY MODEL DIED (2026-07-04 root-cause, kai4):
# Anthropic OAuth refresh tokens are single-use/rotating. Copying ONE grant's
# credentials to 11 homes meant 11 sessions racing to refresh the SAME refresh
# token at access-token expiry (~8h). The first refresher wins and gets a new
# pair; the rotation invalidates everyone else's copy → mass 401 death.
# Observed live 2026-07-04 10:46Z: kai3 won (fresh pair 10:47:34), guru/kai1/
# kai2/munshi/pulse/rishi all failed-refresh at 10:59-11:00, daroga/raju/vaidya
# never tried. The 6h copy timer didn't fix the disease — it synchronized the
# time bomb.
#
# THE FIX (what the owner asked for: one auth per machine, like his Mac):
# every son's .claude/.credentials.json is a SYMLINK to parent's
# /home/owner/.claude/.credentials.json. Any session that refreshes writes
# the new pair through the link into the one shared file; rotation is harmless
# because there are no stale copies.
#
# THIS SCRIPT is the guard that keeps that true (runs every 5 min via the
# repurposed refresh-sons-creds.timer):
#   1. If a son's creds is a REGULAR FILE again, Claude Code clobbered the
#      symlink during a refresh (atomic-rename write). That file then holds
#      the NEWEST grant on the box — promote it to parent, re-link the son.
#   2. Warn (TG, via parent's bot) if parent's grant is expired >30 min —
#      means every session is dying and a human /login is needed.
set -uo pipefail

PARENT_HOME=/home/owner
PARENT=$PARENT_HOME/.claude/.credentials.json
LOG=$PARENT_HOME/kai/logs/refresh-sons.log
ALERT_CHAT="${OWNER_CHAT_ID:-}"
STATE_FLAG=$PARENT_HOME/kai/state/creds-expired-alerted
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

alert() {
  local token
  token=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K.*' "$PARENT_HOME/.claude/channels/telegram/.env" 2>/dev/null || true)
  [ -z "$token" ] && return 0
  curl -sS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
    -d chat_id="$ALERT_CHAT" --data-urlencode text="$1" >/dev/null 2>&1 || true
}

if [ ! -e "$PARENT" ]; then
  log "ERROR: parent creds missing"
  alert "🔴 creds-guard: parent credentials file MISSING at $PARENT — fleet auth broken."
  exit 1
fi

# ── 0. .secrets symlink guard ──────────────────────────────────────────────
# Sons run under a HOME-override, so `~/.secrets/...` resolves inside the son's
# home. The real secrets (Sarvam STT key, bot tokens, etc.) live only in the
# parent home, so any son without a .secrets link silently breaks skills that
# source them — e.g. the voice-bridge transcriber (daroga hit this 2026-07-07:
# "line 22: /home/owner/darog...: No such file or directory"). Link every
# son's .secrets to the parent's, unless the son deliberately keeps a real dir.
for son_home in $PARENT_HOME/*-home; do
  [ -d "$son_home" ] || continue
  s="$son_home/.secrets"
  if [ -L "$s" ] || [ -d "$s" ]; then
    continue                                  # healthy symlink, or a real dir we won't clobber
  fi
  # missing (or a stale broken symlink) → (re)link to the parent secrets
  rm -f "$s" 2>/dev/null
  ln -s "$PARENT_HOME/.secrets" "$s" && log "linked .secrets for $(basename "$son_home")"
done

# ── 1. symlink repair (clobber = newest grant; promote then re-link) ───────
for son_home in $PARENT_HOME/*-home; do
  [ -d "$son_home/.claude" ] || continue
  t="$son_home/.claude/.credentials.json"
  if [ -L "$t" ]; then
    continue                                  # healthy symlink
  fi
  if [ -f "$t" ]; then
    # Regular file = a refresh wrote here via rename. If it's fresher than
    # parent, it IS the canonical grant now — promote before re-linking.
    if [ "$t" -nt "$PARENT" ]; then
      cp "$t" "$PARENT" && chmod 600 "$PARENT"
      log "PROMOTED fresher grant from $son_home to parent (symlink was clobbered by refresh)"
    else
      log "re-linking $son_home (clobbered but parent is fresher)"
    fi
    rm -f "$t"
  fi
  ln -s "$PARENT" "$t"
  log "re-linked $t"
done

# ── 2. parent grant validity ───────────────────────────────────────────────
now_ms=$(date +%s%3N)
exp_ms=$(jq -r '.claudeAiOauth.expiresAt // 0' "$PARENT" 2>/dev/null || echo 0)
if [ "${exp_ms:-0}" -le $((now_ms - 1800000)) ]; then
  # >30 min past expiry and nobody's refresh has landed — human needed.
  if [ ! -f "$STATE_FLAG" ] || [ $(( $(date +%s) - $(stat -c %Y "$STATE_FLAG") )) -gt 21600 ]; then
    mins_ago=$(( (now_ms - exp_ms) / 60000 ))
    alert "🔴 creds-guard: the machine-wide OAuth grant expired ${mins_ago}m ago and no session has refreshed it — the whole fleet will 401. Fix: /login in any one session (it heals all via the shared file)."
    touch "$STATE_FLAG"
    log "ALERT parent grant expired ${mins_ago}m"
  fi
else
  rm -f "$STATE_FLAG" 2>/dev/null || true
fi
