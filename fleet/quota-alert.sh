#!/usr/bin/env bash
#
# quota-alert.sh - the OPPOSITE edge from fleet-watchdog's limit warnings.
#
# The watchdog shouts when a pool is nearly EXHAUSTED (5h >= 80/95%,
# 7d >= 70/85%). This one shouts when a pool is about to waste what the owner
# already paid for: weekly budget left that the remaining hours cannot absorb.
# Both are needed; neither sees the other's failure.
#
# Runs hourly as a systemd user timer on server (kai's machine). Reads
# fleet/quota.sh --json - same source as the `quota` CLI and kushbot's /quota,
# so the three can never disagree about whether something is at risk.
#
# Alerting discipline, copied from fleet-watchdog because it is what works:
#   - fires on TRANSITION into at-risk, not every cycle
#   - reminds every 6h while still at risk
#   - when a pool leaves at-risk it says WHY: budget spent (green tick) or week
#     rolled with the remainder lost (no tick - that is the failure, not a fix)
#   - stale and expired readings never fire at all (guarded inside quota.sh)
# Plus a low-noise Monday 09:00 IST summary of what each pool ENDED the week at,
# which is the only number that says how much was actually lost.
#
# State: ~/kai/state/quota-alert.json. Log: ~/kai/logs/quota-alert.log.
# Usage: quota-alert.sh [--dry-run]     (dry-run prints the decision, sends nothing)

set -uo pipefail

DRY=${1:-}
BASE=${QUOTA_ALERT_BASE:-/home/owner}
STATE_DIR=$BASE/kai/state
STATE=$STATE_DIR/quota-alert.json
LOG=$BASE/kai/logs/quota-alert.log
ALERT_CHAT=${QUOTA_ALERT_CHAT:-${OWNER_CHAT_ID:-}}
PARENT_ENV=$BASE/.claude/channels/telegram/.env
QUOTA=${QUOTA_SH:-$BASE/kai/quota.sh}
REMIND_S=$((6 * 3600))
PARKED=~/monorepo/team/parked-work.md

mkdir -p "$STATE_DIR" "$(dirname "$LOG")" 2>/dev/null
[ -f "$STATE" ] || echo '{"pools":{},"weekly_summary":""}' > "$STATE"

# --dry-run is a read-only rehearsal: it must not write the state file (already
# guarded at the bottom) and must not write the log either. A dry run that logs
# leaves "sent clear for codex" lines next to no send, which is the worst kind of
# evidence to debug from.
log() {
  [ "$DRY" = "--dry-run" ] && return 0
  echo "$(date -u +%FT%TZ) $*" >> "$LOG" 2>/dev/null
}
now=$(date +%s)
ist_date=$(TZ=Asia/Kolkata date +%F)
ist_dow=$(TZ=Asia/Kolkata date +%u)      # 1 = Monday
ist_hour=$(TZ=Asia/Kolkata date +%H); ist_hour=${ist_hour#0}; ist_hour=${ist_hour:-0}

# Same send path as fleet-watchdog.sh: Telegram Bot API by curl, parent kai's
# token (the bot the owner already has a chat with).
send_tg() {  # $1 = text
  if [ "$DRY" = "--dry-run" ]; then printf 'DRY SEND:\n%s\n\n' "$1"; return 0; fi
  local tok
  tok=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K.*' "$PARENT_ENV" 2>/dev/null | head -1)
  [ -z "$tok" ] && { log "no bot token at $PARENT_ENV"; return 1; }
  curl -sS -m 10 "https://api.telegram.org/bot${tok}/sendMessage" \
    -d chat_id="$ALERT_CHAT" --data-urlencode text="$1" >/dev/null 2>&1
}

REPORT=$(bash "$QUOTA" --json 2>/dev/null)
if [ -z "$REPORT" ] || ! echo "$REPORT" | jq -e '.pools' >/dev/null 2>&1; then
  log "quota.sh produced nothing usable"
  [ "$DRY" = "--dry-run" ] && echo "quota.sh produced nothing usable ($QUOTA)"
  exit 1
fi

ST=$(cat "$STATE" 2>/dev/null); echo "$ST" | jq -e . >/dev/null 2>&1 || ST='{"pools":{},"weekly_summary":""}'

# ---------------------------------------------------------------------------
# Per-pool transition handling
# ---------------------------------------------------------------------------
while IFS=$'\t' read -r pool risk rem hrs wins reset_ist reset_epoch weekly_pct; do
  [ -n "$pool" ] || continue
  prev_risk=$(echo "$ST" | jq -r --arg p "$pool" '.pools[$p].risk // 0')
  prev_sent=$(echo "$ST" | jq -r --arg p "$pool" '.pools[$p].last_sent // 0')
  prev_reset=$(echo "$ST" | jq -r --arg p "$pool" '.pools[$p].reset // ""')
  prev_pct=$(echo "$ST" | jq -r --arg p "$pool" '.pools[$p].pct // ""')

  # Week rolled over: bank what the pool ENDED the previous week at. This is the
  # only moment the "how much did we lose" number exists - after the reset the
  # counter is back to ~0 and the answer is gone forever.
  #
  # rolled also decides which "no longer at risk" message is true (see below), so
  # it is computed before the send decision, not after.
  rolled=0; rolled_unspent=""
  if [ -n "$prev_reset" ] && [ "$prev_reset" != "null" ] && [ -n "$reset_epoch" ] \
     && [ "${reset_epoch%.*}" -gt "${prev_reset%.*}" ] 2>/dev/null \
     && [ -n "$prev_pct" ] && [ "$prev_pct" != "null" ]; then
    ST=$(echo "$ST" | jq --arg p "$pool" --argjson r "$prev_reset" --argjson pc "$prev_pct" \
      '.pools[$p].ended = ([{reset:$r, pct:$pc}] + (.pools[$p].ended // []))[0:4]')
    rolled=1; rolled_unspent=$(( 100 - ${prev_pct%.*} ))
    log "$pool week rolled: ended at ${prev_pct}%"
  fi

  send=0; kind=""
  if [ "$risk" = "true" ]; then
    if [ "$prev_risk" != "1" ]; then send=1; kind="new"
    elif [ $(( now - ${prev_sent%.*} )) -ge $REMIND_S ]; then send=1; kind="reminder"
    fi
  else
    if [ "$prev_risk" = "1" ]; then send=1; kind="clear"; fi
  fi

  if [ "$send" = 1 ]; then
    if [ "$kind" = "clear" ]; then
      # Two very different things end an at-risk state, and calling both of them
      # "no longer at risk" was a green tick for a loss. Either the budget got
      # SPENT (good), or the week simply reset and the remainder evaporated
      # (exactly the outcome the alert existed to prevent). rolled tells them
      # apart: the reset timestamp advanced while the pool was still flagged.
      if [ "$rolled" = 1 ]; then
        msg="⚪ $pool week rolled: ${rolled_unspent}% of the weekly budget went unspent.
New week ends ${reset_ist:-?}.
Parked queue: $PARKED"
      else
        msg="✅ $pool no longer at risk of wasting its weekly budget."
      fi
    else
      pfx="🟠"; [ "$kind" = "reminder" ] && pfx="🟠 (still)"
      msg="$pfx $pool week ends $reset_ist, ${rem}% unspent, ${hrs} hours left, roughly ${wins} five-hour windows: park work now or lose it.
Parked queue: $PARKED"
    fi
    send_tg "$msg" && log "sent $kind for $pool"
    ST=$(echo "$ST" | jq --arg p "$pool" --argjson ts "$now" '.pools[$p].last_sent = $ts')
  fi

  ST=$(echo "$ST" | jq --arg p "$pool" \
        --argjson rk "$([ "$risk" = "true" ] && echo 1 || echo 0)" \
        --argjson r "${reset_epoch:-null}" --argjson pc "${weekly_pct:-null}" --argjson ts "$now" \
        '.pools[$p].risk = $rk | .pools[$p].reset = $r | .pools[$p].pct = $pc | .pools[$p].seen = $ts')

  [ "$DRY" = "--dry-run" ] && printf 'DECISION %-16s risk=%-5s rem=%s%% hrs=%s wins=%s prev_risk=%s rolled=%s action=%s\n' \
    "$pool" "$risk" "${rem:-?}" "${hrs:-?}" "${wins:-?}" "$prev_risk" "$rolled" "${kind:-none}${rolled_unspent:+ (week-rolled)}"
done < <(echo "$REPORT" | jq -r '.pools[]
  | [ .pool,
      (.at_risk|tostring),
      (.weekly_remaining_pct // ""|tostring),
      (.hours_left // ""|tostring),
      (.windows_left // ""|tostring),
      (.weekly_reset_ist // ""),
      (.weekly_reset // ""|tostring),
      (.weekly_pct // ""|tostring) ] | @tsv')

# ---------------------------------------------------------------------------
# Monday 09:00 IST weekly summary. The hourly timer never lands exactly on
# 09:00 IST (03:30 UTC), so the rule is "first run at or after 09:00 IST on a
# Monday, once per IST date" - which survives a missed cycle or a reboot.
# ---------------------------------------------------------------------------
last_summary=$(echo "$ST" | jq -r '.weekly_summary // ""')
want_summary=0
[ "$ist_dow" = "1" ] && [ "$ist_hour" -ge 9 ] 2>/dev/null && [ "$last_summary" != "$ist_date" ] && want_summary=1
[ "${QUOTA_ALERT_FORCE_SUMMARY:-}" = "1" ] && want_summary=1

# Nothing to summarise until at least one pool has a COMPLETED week banked.
# Otherwise the first Monday after install sends "no completed week recorded yet"
# four times, which is pure noise and teaches the owner to ignore the channel.
if [ "$want_summary" = 1 ]; then
  banked=$(echo "$ST" | jq '[.pools[]? | .ended[0]?.pct] | map(select(. != null)) | length')
  if [ "${banked:-0}" -eq 0 ] 2>/dev/null; then
    log "weekly summary skipped: no completed week banked yet"
    [ "$DRY" = "--dry-run" ] && echo "SUMMARY: skipped (no completed week banked yet)"
    want_summary=0
    ST=$(echo "$ST" | jq --arg d "$ist_date" '.weekly_summary = $d')
  fi
fi

if [ "$want_summary" = 1 ]; then
  lines="📊 Weekly quota summary ($ist_date IST)"
  while IFS=$'\t' read -r pool pct rem reset_ist; do
    [ -n "$pool" ] || continue
    ended=$(echo "$ST" | jq -r --arg p "$pool" '.pools[$p].ended[0].pct // ""')
    if [ -n "$ended" ] && [ "$ended" != "null" ]; then
      lines="$lines
$pool: last week ended at ${ended}% used ($(( 100 - ${ended%.*} ))% of the budget expired unspent)"
    else
      lines="$lines
$pool: no completed week recorded yet"
    fi
    [ -n "$pct" ] && [ "$pct" != "null" ] && lines="$lines
  now: ${pct}% used, ${rem}% left, week ends ${reset_ist:-?}"
  done < <(echo "$REPORT" | jq -r '.pools[] | [ .pool, (.weekly_pct // ""|tostring), (.weekly_remaining_pct // ""|tostring), (.weekly_reset_ist // "") ] | @tsv')
  lines="$lines

Parked queue: $PARKED"
  send_tg "$lines" && log "sent weekly summary"
  ST=$(echo "$ST" | jq --arg d "$ist_date" '.weekly_summary = $d')
fi

# Persist state (temp + mv: a killed cycle must not leave a truncated file that
# resets every pool's transition memory and re-alerts on the next run).
if [ "$DRY" != "--dry-run" ]; then
  printf '%s' "$ST" > "$STATE.$$" 2>/dev/null && mv -f "$STATE.$$" "$STATE" 2>/dev/null
  rm -f "$STATE.$$" 2>/dev/null
fi
log "cycle done"
