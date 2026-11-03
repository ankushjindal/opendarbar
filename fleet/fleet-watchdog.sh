#!/usr/bin/env bash
# fleet-watchdog — external health monitor for the server agent fleet.
#
# THE design principle (kushbot-improvements 2026-07-03, roadmap item 1):
# every prior signal (🔴 detach notice, /heartbeat, /status) lives INSIDE the
# process that dies. This watchdog is a systemd user timer OUTSIDE all of them,
# so it survives OOM kills, tmux kills, OAuth rot, and full-fleet death.
#
# Checks per son (roster below):
#   D1 tmux session exists
#   D2 claude proc for that agent alive
#   D3 bun kushbot MCP child alive (cwd = <home>/.claude/plugins/local/kushbot)
#   D4 claim file pid alive (stale claim = deaf bot even when all else lives)
#   D5 creds age < 26h (refresh timer should keep them younger)
# Account-level (once, not per son):
#   L1 5h limit >= 80% warn / >= 95% urgent (freshest statusline cache)
#   L2 7d limit >= 70% warn / >= 85% urgent
#   B1 reboot detection (uptime < 6 min => "fleet down" alert)
#
# Alerts: Telegram Bot API direct (curl) — each dead son's OWN token delivers
# its own obituary into the chat the owner already has with it; fallback = parent
# kai's token. Fires on state TRANSITION only; reminds every 6h while broken;
# sends all-clear on recovery. State: ~/kai/state/fleet-watchdog.json
#
# Usage: fleet-watchdog.sh [--dry-run]   (dry-run prints, sends nothing)
set -uo pipefail

DRY=${1:-}
BASE=/home/owner
STATE_DIR=$BASE/kai/state
STATE=$STATE_DIR/fleet-watchdog.json
LOG=$BASE/kai/logs/fleet-watchdog.log
ALERT_CHAT="${OWNER_CHAT_ID:-}"
REMIND_S=$((6*3600))
PARENT_ENV=$BASE/.claude/channels/telegram/.env
mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
[ -f "$STATE" ] || echo '{}' > "$STATE"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

# roster from the fleet registry (single source of truth since 2026-07-06 —
# same file drives A2A allowlist, fleet-ctl, and this). parent kai included
# (never auto-restarted). parked agents: no death alerts, creds still guarded.
REG=$BASE/.claude/channels/fleet/registry.json
ROSTER=$(jq -r '.agents[] | select(.machine == "server") | "\(.name)|\(.home)|\(.tmux)"' "$REG" 2>/dev/null)
PARKED=$(jq -r '[.agents[] | select(.machine == "server" and .parked == true) | .name] | join(" ")' "$REG" 2>/dev/null)
AUTO_RESTART=$(jq -r '.autoRestart // false' "$REG" 2>/dev/null)

bot_token() { # $1 = home
  grep -oP '^TELEGRAM_BOT_TOKEN=\K.*' "$1/.claude/channels/telegram/.env" 2>/dev/null | head -1
}

send_tg() { # $1 = home-for-token, $2 = text
  [ "$DRY" = "--dry-run" ] && { echo "DRY: [$1] $2"; return 0; }
  local tok; tok=$(bot_token "$1")
  [ -z "$tok" ] && tok=$(bot_token "$BASE")           # fallback: parent token
  [ -z "$tok" ] && { log "no token for $1 and no parent fallback"; return 1; }
  curl -sS -m 10 "https://api.telegram.org/bot${tok}/sendMessage" \
    -d chat_id="$ALERT_CHAT" --data-urlencode text="$2" >/dev/null 2>&1
}

# Operational telemetry: record an event WITHOUT notifying (the owner 2026-07-14 —
# "seldom important but too noisy"). Lands in the son's own ops log, which is what
# `/inspect` reads in Telegram. The rule: routine + self-healed => ops_log only;
# needs-a-human => ops_log AND send_tg. The bot's 🔴 name prefix already conveys
# "this is down", so being down is not, by itself, worth a notification.
ops_log() { # home event detail [sev]
  local home="$1" event="$2" detail="$3" sev="${4:-info}" f
  f="$home/.claude/channels/telegram/ops.jsonl"
  [ -d "$(dirname "$f")" ] || return 0
  printf '{"ts":%s,"sev":"%s","event":"%s","detail":%s}\n' \
    "$(( $(date +%s) * 1000 ))" "$sev" "$event" \
    "$(jq -Rn --arg d "$detail" '$d' 2>/dev/null || echo '""')" >> "$f" 2>/dev/null || true
}

# True (0) if pid $1 is a descendant of pid $2 (walks the ppid chain to init).
is_descendant_of() {
  local p anc; anc=$(ps -o ppid= -p "$1" 2>/dev/null | tr -d ' ')
  while [ -n "$anc" ] && [ "$anc" -gt 1 ] 2>/dev/null; do
    [ "$anc" = "$2" ] && return 0
    anc=$(ps -o ppid= -p "$anc" 2>/dev/null | tr -d ' ')
  done
  return 1
}

now=$(date +%s)

# ── state helpers (jq) ───────────────────────────────────────────────────
st_get() { jq -r --arg k "$1" '.[$k].status // "ok"' "$STATE"; }
st_ts()  { jq -r --arg k "$1" '.[$k].last_alert // 0' "$STATE"; }
st_set() { # key status [alert_ts]
  local tmp; tmp=$(mktemp)
  jq --arg k "$1" --arg s "$2" --argjson t "${3:-0}" \
    '.[$k] = {status: $s, last_alert: (if $t == 0 then (.[$k].last_alert // 0) else $t end)}' \
    "$STATE" > "$tmp" && mv "$tmp" "$STATE"
}

# transition-aware alert: fires on ok->bad, re-fires every REMIND_S, all-clears on bad->ok
raise() { # key home message
  local key=$1 home=$2 msg=$3 prev last
  prev=$(st_get "$key"); last=$(st_ts "$key")
  if [ "$prev" = "ok" ] || [ $((now - last)) -ge $REMIND_S ]; then
    ops_log "$home" "$key" "$msg" alert
    send_tg "$home" "$msg" && st_set "$key" bad "$now" || st_set "$key" bad "$now"
    log "ALERT $key: $msg"
  else
    st_set "$key" bad
  fi
}
clear_key() { # key home name
  local key=$1 home=$2 label=$3
  if [ "$(st_get "$key")" = "bad" ]; then
    # Recovery is the EXPECTED state, not news. Log it; the bot's name already
    # dropped its 🔴 when it came back up.
    ops_log "$home" "recovered" "$label"
    log "CLEAR $key"
  fi
  st_set "$key" ok
}

# auto_heal: shared remediation for the three recoverable death states — DEAD
# (tmux/claude gone), MUTE (claude alive, MCP child dead), DEAF (stale claim, no
# takeover). All three heal the same way: `fleet-ctl start` reaps whatever is left
# and resumes the SAME session (captures the session id, splices -r). Before this,
# only DEAD auto-restarted; MUTE/DEAF alerted forever — which is why rishi sat deaf
# for 3 days (2026-07-07 → 07-10) re-nagging every 6h with a fix nobody ran.
# Rate-capped to 2 heals per son per 6h, SHARED across all three states (one
# wd-restarts-<name> ledger), so a son flapping between states can't restart-loop.
# Optional $4 is a pre-heal shell command (DEAF passes the stale-claim rm).
# Returns 0 healed · 1 attempted-but-failed (alert already sent) · 2 not eligible
# or cap hit (caller should raise its normal alert). Parent kai is never silently
# healed — its restart captures a live cmdline and is where the owner usually is.
auto_heal() { # $1 name  $2 home  $3 reason  [$4 pre-cmd]
  local name=$1 home=$2 reason=$3 precmd=${4:-}
  [ "$AUTO_RESTART" = "true" ] || return 2
  [ "$name" = "kai" ] && return 2
  local rc_file="$STATE_DIR/wd-restarts-$name" recent
  recent=$(awk -v cut=$((now - 21600)) '$1 > cut' "$rc_file" 2>/dev/null | wc -l)
  [ "$recent" -ge 2 ] && return 2
  if [ "$DRY" = "--dry-run" ]; then
    echo "DRY: would auto-heal $name ($reason)$( [ -n "$precmd" ] && echo " [pre: $precmd]" ) via fleet-ctl start"
    return 0
  fi
  echo "$now" >> "$rc_file"
  [ -n "$precmd" ] && eval "$precmd" >/dev/null 2>&1
  log "auto-healing $name ($reason) attempt $((recent + 1))/2 this 6h"
  if $BASE/kai/fleet-ctl start "$name" >/dev/null 2>&1; then
    # "no action needed" is precisely why this should not interrupt him.
    ops_log "$home" "auto_healed" "$name ($reason) — session resumed"
    st_set "son_$name" ok
    return 0
  fi
  ops_log "$home" "auto_heal_failed" "$name ($reason)" alert
  send_tg "$home" "🔴 watchdog tried to auto-heal $name ($reason) and FAILED — manual: ~/kai/fleet-ctl start $name"
  st_set "son_$name" bad "$now"
  return 1
}

# ── B1: reboot detection ─────────────────────────────────────────────────
up_s=$(awk '{print int($1)}' /proc/uptime)
if [ "$up_s" -lt 360 ]; then
  if [ "$(st_get reboot)" = "ok" ]; then
    send_tg "$BASE" "🔴 server REBOOTED $(awk '{print int($1/60)}' /proc/uptime) min ago — entire fleet is down (nothing auto-restarts yet). Restore: ~/kai/fleet-ctl boot-restore"
    st_set reboot bad "$now"
  fi
else
  st_set reboot ok
fi

# ── D6: disk space ───────────────────────────────────────────────────────
# 2026-07-07: root hit 100% mid-reload-sweep — pulse+rishi failed to relaunch,
# transcript appends + creds writes were one write away from corrupting fleet
# state. GB thresholds (not %): what matters is whether a restart can survive.
disk_avail_kb=$(df --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
disk_pct=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$disk_avail_kb" ]; then
  disk_avail_h=$(( disk_avail_kb / 1024 / 1024 ))G; [ "$disk_avail_kb" -lt 1048576 ] && disk_avail_h=$(( disk_avail_kb / 1024 ))M
  if [ "$disk_avail_kb" -lt 1048576 ]; then      # < 1G: restarts will start failing
    raise disk "$BASE" "🔴 disk: only ${disk_avail_h} free (${disk_pct}%) — session restarts WILL fail and transcript/creds writes are at risk. Quick wins: rm -rf ~*/.npm/_cacache ~*/.cache/claude/staging /tmp build caches; journalctl --vacuum-size=100M; snap old revisions."
  elif [ "$disk_avail_kb" -lt 2621440 ]; then    # < 2.5G: getting tight
    raise disk "$BASE" "⚠️ disk: ${disk_avail_h} free (${disk_pct}%) — clean up before it bites (npm caches, ~*/.cache/claude/staging, /tmp, journal, snap old revs)."
  else
    clear_key disk "$BASE" "disk space"
  fi
fi

# ── per-son checks ───────────────────────────────────────────────────────
while IFS='|' read -r name home sess; do
  [ -z "$name" ] && continue
  parked=0; case " $PARKED " in *" $name "*) parked=1;; esac

  # planned-reload maintenance gate: `fleet-ctl reload --soft` writes an expiry
  # epoch to state/maint-<name>. While it's in the future, skip this son wholesale
  # — no DEAD alert, no auto-restart race with fleet-ctl, no 🟢 recovery ping.
  # Stale flag (past its epoch) is removed and the son checked normally.
  maint="$STATE_DIR/maint-$name"
  if [ -f "$maint" ]; then
    mexp=$(cat "$maint" 2>/dev/null || echo 0)
    if [ "${mexp:-0}" -gt "$now" ] 2>/dev/null; then
      log "skip $name — planned-reload maintenance until $mexp"
      continue
    fi
    rm -f "$maint"
  fi

  # D2/D3: claude proc + bun MCP child, matched via /proc cwd + environ HOME
  claude_pid=""; bun_pid=""
  for pid in $(pgrep -f 'plugins/local/kushbot' 2>/dev/null); do
    cwd=$(readlink /proc/$pid/cwd 2>/dev/null) || continue
    case "$cwd" in "$home"/.claude/plugins/local/kushbot) bun_pid=$pid;; esac
  done
  if [ "$name" = "parent-kai" ]; then
    claude_pid=$(pgrep -f "claude.*--dangerously-load-development-channels" 2>/dev/null | while read -r p; do
      h=$(tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -oP '^HOME=\K.*')
      [ "$h" = "$home" ] || [ -z "$h" ] && { echo "$p"; break; }; done | head -1)
  else
    claude_pid=$(pgrep -f "claude.*--agent" 2>/dev/null | while read -r p; do
      h=$(tr '\0' '\n' </proc/$p/environ 2>/dev/null | grep -oP '^HOME=\K.*')
      [ "$h" = "$home" ] && { echo "$p"; break; }; done | head -1)
  fi

  # D7: orphaned-poller sweep. A legit bun poller is a descendant of the son's
  # live claude. An orphan (its claude parent died, so it reparented to init or
  # systemd) keeps polling the bot token and STEALS updates — the 2026-07-07
  # zombie that ate kai's DMs for 3 days, invisible to D1-D6 (tmux/claude/bun/
  # claim all looked fine). Kill any bun-kushbot-for-this-home that is (a) NOT a
  # descendant of the live claude AND (b) reparented to init/systemd. That two-part
  # signature is precise: a legit child of live claude OR codex (parent bun/codex,
  # not systemd) never matches, so this can't misfire on healthy or codex sons.
  if [ -n "$claude_pid" ]; then
    for bp in $(pgrep -f 'plugins/local/kushbot' 2>/dev/null); do
      bcwd=$(readlink "/proc/$bp/cwd" 2>/dev/null) || continue
      [ "$bcwd" = "$home/.claude/plugins/local/kushbot" ] || continue
      is_descendant_of "$bp" "$claude_pid" && continue     # legit child of live claude
      bppid=$(ps -o ppid= -p "$bp" 2>/dev/null | tr -d ' ')
      bpcomm=$(ps -o comm= -p "${bppid:-0}" 2>/dev/null | tr -d ' ')
      if [ "${bppid:-0}" = "1" ] || echo "$bpcomm" | grep -qi systemd; then
        kill "$bp" 2>/dev/null || true; sleep 1; kill -9 "$bp" 2>/dev/null || true
        log "D7 reaped ORPHAN poller $bp (home $home, reparented to ${bpcomm:-init}) — was stealing $name's updates"
        ops_log "$home" "orphan_poller_reaped" "$name pid $bp (reparented to ${bpcomm:-init})"
      fi
    done
  fi

  # D1: tmux
  tmux_ok=0; tmux has-session -t "$sess" 2>/dev/null && tmux_ok=1

  # D4: claim file
  claim_ok=1
  claim_file="$home/.claude/channels/telegram/claimed_by.pid"
  if [ -f "$claim_file" ]; then
    cpid=$(cat "$claim_file" 2>/dev/null)
    [ -n "$cpid" ] && ! kill -0 "$cpid" 2>/dev/null && claim_ok=0
  fi

  # D5: creds present. Age/validity of the MACHINE grant is the symlink-guard's
  # job (refresh-sons-creds.sh alerts once, from parent's bot, when the grant
  # sits expired >30min). Per-son age checks are meaningless under shared auth
  # — and v1's stat-without--L measured the SYMLINK's own age, which only grows,
  # so every son crossed 26h and re-alarmed every 6h from its own bot
  # (2026-07-06 notification-spam incident). Only alarm if the file is GONE.
  creds="$home/.claude/.credentials.json"
  creds_ok=1
  [ ! -e "$creds" ] && creds_ok=0

  # verdicts
  if [ $parked -eq 1 ] && [ $tmux_ok -eq 0 ]; then
    clear_key "son_$name" "$home" "$name" # parked & down = expected, keep ok
    continue
  fi
  if [ $tmux_ok -eq 0 ] || [ -z "$claude_pid" ]; then
    # DEAD: tmux/claude gone. Auto-heal (opt-in via registry.autoRestart, never
    # parent kai); on cap-hit or ineligible, fall through to a loud alert.
    auto_heal "$name" "$home" "$( [ $tmux_ok -eq 0 ] && echo 'tmux gone' || echo 'claude gone' )"
    case $? in 0|1) continue;; esac
    raise "son_$name" "$home" "🔴 $name DEAD: $( [ $tmux_ok -eq 0 ] && echo 'tmux session gone' || echo 'claude proc gone' ). Bot may still receive but will never answer. Restore: ~/kai/fleet-ctl start $( [ "$name" = kai ] && echo 'kai (parent — captures live cmdline, be careful)' || echo "$name")"
  elif [ -z "$bun_pid" ]; then
    # MUTE: claude alive, MCP child dead. Same heal (fleet-ctl start reaps + resumes).
    auto_heal "$name" "$home" "MCP dead"
    case $? in 0|1) continue;; esac
    raise "son_$name" "$home" "🔴 $name MUTE: claude alive but kushbot MCP (bun) is dead — it can't hear or send Telegram. Claude 2.1.x won't respawn it. Restore: ~/kai/fleet-ctl start $name"
  elif [ $claim_ok -eq 0 ]; then
    # DEAF: stale claim held by a dead pid, no takeover. Heal removes the stale
    # claim first, then restarts (the restart writes a fresh live claim).
    auto_heal "$name" "$home" "stale claim" "rm -f $claim_file"
    case $? in 0|1) continue;; esac
    raise "son_$name" "$home" "⚠️ $name DEAF: stale claimed_by.pid ($cpid dead) — poller refuses updates; messages pile up at Telegram. Restore: rm $claim_file && ~/kai/fleet-ctl start $name"
  elif [ $creds_ok -eq 0 ]; then
    raise "son_$name" "$home" "⚠️ $name has NO credentials file (symlink gone?) — will 401 on next API call. Fix: bash ~/kai/refresh-sons-creds.sh (re-links), then check it."
  else
    clear_key "son_$name" "$home" "$name"
  fi
done <<< "$ROSTER"

# ── L1/L2: account-level limit thresholds (freshest statusline cache) ─────
best=""; best_ts=0
for f in /tmp/.claude_status_*.json; do
  [ -f "$f" ] || continue
  ts=$(jq -r '.ts // 0' "$f" 2>/dev/null); ts=${ts%.*}
  [ "${ts:-0}" -gt "$best_ts" ] 2>/dev/null && { best_ts=$ts; best=$f; }
done
if [ -n "$best" ]; then
  # normalize s vs ms
  [ "$best_ts" -gt 100000000000 ] && best_ts=$((best_ts/1000))
  if [ $((now - best_ts)) -lt 900 ]; then     # only trust caches <15 min old
    five=$(jq -r '.five_h_pct // empty' "$best"); seven=$(jq -r '.seven_d_pct // empty' "$best")
    five_reset=$(jq -r '.five_h_resets // empty' "$best")
    [ -n "$five_reset" ] && [ "${five_reset%.*}" -le "$now" ] 2>/dev/null && five_reset=""
    five=${five%.*}; seven=${seven%.*}
    if [ -n "$five" ]; then
      if [ "$five" -ge 95 ]; then
        raise limit_5h "$BASE" "🔴 5h limit at ${five}% — fleet about to stall.$( [ -n "$five_reset" ] && echo " Resets $(date -d @$five_reset -u +%H:%M)Z ($(( (five_reset - now) / 60 ))m)." )"
      elif [ "$five" -ge 80 ]; then
        raise limit_5h "$BASE" "⚠️ 5h limit at ${five}%.$( [ -n "$five_reset" ] && echo " Resets $(date -d @$five_reset -u +%H:%M)Z ($(( (five_reset - now) / 60 ))m)." )"
      else clear_key limit_5h "$BASE" "5h limit"; fi
    fi
    if [ -n "$seven" ]; then
      if [ "$seven" -ge 85 ]; then
        raise limit_7d "$BASE" "🔴 7d limit at ${seven}% — consider pausing heavy fleet work."
      elif [ "$seven" -ge 70 ]; then
        raise limit_7d "$BASE" "⚠️ 7d limit at ${seven}%."
      else clear_key limit_7d "$BASE" "7d limit"; fi
    fi
  fi
fi

log "cycle done"
