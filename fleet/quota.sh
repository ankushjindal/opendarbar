#!/usr/bin/env bash
#
# quota.sh - one view of every AI budget the owner pays for, on either machine.
#
#   quota                 human table (times in IST)
#   quota --json          machine-readable (kushbot /quota, quota-alert.sh)
#   quota --no-probe      skip the live Claude header probe (cache only)
#
# Four pools, four different truths:
#
#   claude work      you@work.example    Max seat   5h burst + weekly budget
#   claude personal  you@personal.example Team seat  5h burst + weekly budget
#   claude team-a    $100 team seat (18 Oct 2026)  5h burst + weekly budget
#   claude team-owner  $100 team seat (18 Oct 2026)  5h burst + weekly budget
#   codex            you@work.example    Plus       5h primary + weekly secondary
#   grok             you@work.example               weekly credit pool, no 5h
#
# THE REFRAME (2026-09-07): 5h is a burst CAP, weekly is the BUDGET. Nothing is
# lost when a 5h window rolls over. What actually evaporates is the weekly
# remainder at reset. So this tool leads with the weekly number and flags the
# pools whose remaining budget can no longer physically be spent before reset.
#
# Sources, and why each one:
#
#   Claude   there is no GET endpoint for subscription 5h/7d usage under an OAuth
#            token, but the `anthropic-ratelimit-unified-*` headers come back on
#            any /v1/messages call. So: one 1-token haiku POST per account, read
#            the headers, cache 60s in /tmp/.claude_acct_usage_<label>.json - the
#            SAME cache file kushbot's probeAccountUsage() and claude-acct.sh use,
#            so the three of them share one probe instead of each burning a call.
#   Codex    live JSON-RPC `account/rateLimits/read` against `codex app-server`.
#            The session jsonl snapshot LIES (the account is shared with server's
#            codex sons and the web UI, so a local file is only as fresh as this
#            machine's last turn). Fallback = freshest `rate_limits` event across
#            ~/.codex/sessions and ~/.codex/*/sessions, always printed with its age.
#   Grok     ~/.grok/logs/unified.jsonl `creditUsagePercent` + currentPeriod.end.
#            No API; the CLI logs its own billing fetch. Also printed with its age.
#
# Times render in IST because that is where the owner reads them.

set -uo pipefail

JSON=0
NO_PROBE=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --no-probe) NO_PROBE=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "quota: unknown arg '$a' (try --json)" >&2; exit 2 ;;
  esac
done

NOW=$(date +%s)
IST_TZ="Asia/Kolkata"

# Host identity: the SAME two values fleet/statusline.zsh writes into the status
# caches ("server" / "mac"). uname -n gives "server" here and "Owners-MacBook
# -Pro" there, so anything joining a quota report to a status cache by host had to
# special-case both spellings. One vocabulary instead.
RAW_HOST=$(uname -n 2>/dev/null); RAW_HOST=${RAW_HOST%%.*}
case "$RAW_HOST" in
  *server*) HOST_NAME="server" ;;
  *)        HOST_NAME="mac" ;;
esac

# --- platform branch (stat + date-from-epoch are the only real differences) ---
if [ "$(uname -s)" = "Darwin" ]; then
  mtime_of() { stat -f %m "$1" 2>/dev/null || echo 0; }
  at_epoch() { date -r "$1" "+$2" 2>/dev/null; }
else
  mtime_of() { stat -c %Y "$1" 2>/dev/null || echo 0; }
  at_epoch() { date -d "@$1" "+$2" 2>/dev/null; }
fi

# epoch -> "Mon 12 Sep 11:43 IST"; empty in, empty out.
ist() { [ -n "${1:-}" ] && [ "$1" != "null" ] && TZ=$IST_TZ at_epoch "${1%.*}" '%a %d %b %H:%M IST'; }
# seconds -> "3h 12m" / "2d 4h" / "45m"
dur() {
  local s=${1:-0}; [ "$s" -lt 0 ] 2>/dev/null && s=0
  if   [ "$s" -ge 172800 ]; then echo "$((s/86400))d $(((s%86400)/3600))h"
  elif [ "$s" -ge 3600 ];   then echo "$((s/3600))h $(((s%3600)/60))m"
  else echo "$((s/60))m"; fi
}
# round a float ("0.7342" or "74.0") to an integer percent-ish number
r0() { awk "BEGIN{printf \"%d\", ($1)+0.5}" 2>/dev/null || echo 0; }

# ---------------------------------------------------------------------------
# Risk rule. Weekly is the budget, so "will lose" means: the weekly remainder is
# larger than the time left can physically absorb. First cut, deliberately blunt
# (the owner: tune from data later, do not over-model it now):
#     remaining > 25% AND < 24h left    -> at risk
#     remaining > 50% AND < 48h left    -> at risk
# 5h windows left is printed alongside so the number means something: a 5h window
# is the unit of work you can actually dispatch.
# ---------------------------------------------------------------------------
# STALE_S: past this, a reading is not evidence of anything. The alerter reads
# this same function, and a stale row must never wake the owner: server's 46-day-old
# codex snapshot, whose weekly reset is in July, otherwise reports "29% unspent
# with 0h left" forever. A reset in the PAST is expired by definition, whatever
# its age.
STALE_S=${QUOTA_STALE_S:-21600}     # 6h

# int_pct: every percent that reaches bash arithmetic goes through here first.
# "74.318" in a $(( )) is a fatal syntax error, and with `set -uo pipefail` (no
# -e) the failure is invisible: the assignment yields empty, the comparison is
# false, and the risk flag reads 0 for a pool that is genuinely about to waste
# its budget. Producers floor their own output; this is the belt behind it.
int_pct() { local v=${1:-}; v=${v%%.*}; case "$v" in ''|*[!0-9-]*) echo "" ;; *) echo "$v" ;; esac; }

risk_of() {   # $1 = weekly used %, $2 = weekly reset epoch, $3 = age_s
              # -> "0|1<TAB>reason" (reason doubles as the stale explanation)
  local used reset=${2:-} age=${3:-0} rem hrs
  used=$(int_pct "${1:-}")
  if [ -z "$used" ] || [ -z "$reset" ] || [ "$reset" = "null" ]; then printf '0\t\n'; return; fi
  hrs=$(( (${reset%.*} - NOW) / 3600 ))
  if [ "${reset%.*}" -le "$NOW" ] 2>/dev/null; then printf '0\tstale: weekly reset already passed\n'; return; fi
  if [ "${age:-0}" -gt "$STALE_S" ] 2>/dev/null; then printf '0\tstale: reading is %sh old\n' "$(( age / 3600 ))"; return; fi
  rem=$(( 100 - used ))
  [ "$hrs" -lt 0 ] && hrs=0
  if   [ "$rem" -gt 25 ] && [ "$hrs" -lt 24 ]; then printf '1\t%s%% unspent with %sh left\n' "$rem" "$hrs"
  elif [ "$rem" -gt 50 ] && [ "$hrs" -lt 48 ]; then printf '1\t%s%% unspent with %sh left\n' "$rem" "$hrs"
  else printf '0\t\n'; fi
}

# ---------------------------------------------------------------------------
# Claude: one 1-token haiku POST per account, read the unified ratelimit headers.
# Shared 60s cache with kushbot probeAccountUsage() + claude-acct.sh usage.
# Cache schema (do not change without updating src/accounts.ts):
#   {"ts":<epoch ms>,"v":{five,fiveReset,seven,sevenReset,status}}
# ts is read tolerantly (ms or s) because claude-acct.sh historically wrote s.
# ---------------------------------------------------------------------------
ACCT_DIR="$HOME/.config/claude-accounts"

claude_row() {  # $1 = label -> TSV: five_pct five_reset weekly_pct weekly_reset source age status
  local l="$1" tokf="$ACCT_DIR/$1" cache="/tmp/.claude_acct_usage_$1.json"
  local five="" fr="" seven="" sr="" st="" src="probe" age="" ts=""
  [ -r "$tokf" ] || { printf 'ERR\tno token file %s\n' "$tokf"; return 1; }

  if [ -r "$cache" ]; then
    ts=$(jq -r '.ts // empty' "$cache" 2>/dev/null)
    # normalize ms -> s
    [ -n "$ts" ] && [ "${ts%.*}" -gt 100000000000 ] 2>/dev/null && ts=$(( ${ts%.*} / 1000 ))
    [ -z "$ts" ] && ts=$(mtime_of "$cache")
    if [ $(( NOW - ${ts%.*} )) -lt 60 ]; then
      five=$(jq -r '.v.five // empty' "$cache" 2>/dev/null)
      fr=$(jq -r '.v.fiveReset // empty' "$cache" 2>/dev/null)
      seven=$(jq -r '.v.seven // empty' "$cache" 2>/dev/null)
      sr=$(jq -r '.v.sevenReset // empty' "$cache" 2>/dev/null)
      st=$(jq -r '.v.status // empty' "$cache" 2>/dev/null)
      src="cache"; age=$(( NOW - ${ts%.*} ))
    fi
  fi

  if [ -z "$five" ] || [ -z "$fr" ]; then
    if [ "$NO_PROBE" = 1 ]; then printf 'ERR\tno fresh cache and --no-probe\n'; return 1; fi
    local hdr
    hdr=$(curl -s -m 25 -D - -o /dev/null https://api.anthropic.com/v1/messages \
      -H "authorization: Bearer $(cat "$tokf")" \
      -H "anthropic-version: 2023-06-01" \
      -H "anthropic-beta: oauth-2025-04-20" \
      -H "content-type: application/json" \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"x"}]}' 2>/dev/null)
    hv() { echo "$hdr" | grep -i "^anthropic-ratelimit-unified-$1:" | awk '{print $2}' | tr -d '\r' | head -1; }
    five=$(hv 5h-utilization); fr=$(hv 5h-reset)
    seven=$(hv 7d-utilization); sr=$(hv 7d-reset)
    st=$(hv status); [ -z "$st" ] && st="?"
    if [ -n "$five" ] && [ -n "$fr" ]; then
      printf '{"ts":%s,"v":{"five":%s,"fiveReset":%s,"seven":%s,"sevenReset":%s,"status":"%s"}}' \
        "$(( NOW * 1000 ))" "$five" "$fr" "${seven:-0}" "${sr:-0}" "$st" > "$cache.$$" 2>/dev/null \
        && mv -f "$cache.$$" "$cache" 2>/dev/null
      rm -f "$cache.$$" 2>/dev/null
      src="probe"; age=0
    fi
  fi

  if [ -z "$five" ] || [ -z "$fr" ]; then printf 'ERR\tprobe failed (token revoked or network)\n'; return 1; fi
  # utilization is a FRACTION (0-1) in the headers
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(r0 "$five*100")" "${fr%.*}" "$(r0 "${seven:-0}*100")" "${sr%.*}" "$src" "${age:-0}" "${st:-?}"
}

# ---------------------------------------------------------------------------
# Codex: live first. `codex app-server` speaks JSON-RPC on stdio and answers
# `account/rateLimits/read` with {rateLimits:{primary,secondary}} in camelCase.
# Mechanics: stdin must stay OPEN until the answer arrives (closing it makes the
# server exit before replying), so drive it through a fifo we hold on fd 9 and
# SIGKILL the child the moment we have the line. SIGTERM + wait costs ~20s;
# SIGKILL is ~0. Whole thing lands in 2-6s.
# ---------------------------------------------------------------------------
codex_rpc() {
  command -v codex >/dev/null 2>&1 || return 1
  local d f out pid i line
  d=$(mktemp -d 2>/dev/null) || return 1
  f="$d/in"; out="$d/out"
  mkfifo "$f" 2>/dev/null || { rm -rf "$d"; return 1; }
  : > "$out"
  codex app-server < "$f" > "$out" 2>/dev/null &
  pid=$!
  exec 9> "$f"
  printf '%s\n' \
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"kushdarbar-quota","title":"quota","version":"1.0.0"}}}' \
    '{"method":"initialized","params":null}' \
    '{"id":2,"method":"account/rateLimits/read","params":null}' >&9 2>/dev/null
  line=""
  for i in $(seq 1 100); do          # 100 x 0.1s = 10s ceiling
    line=$(grep -m1 '"id":2' "$out" 2>/dev/null)
    [ -n "$line" ] && break
    sleep 0.1
  done
  exec 9>&-
  kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  rm -rf "$d"
  [ -n "$line" ] || return 1
  # an expired ChatGPT token comes back as a JSON-RPC error, not a result
  echo "$line" | jq -e '.result.rateLimits' >/dev/null 2>&1 || return 1
  printf '%s\n' "$line"
}

# Fallback: freshest `rate_limits` event in any codex rollout jsonl on this box.
# Snake_case there (used_percent / resets_at), camelCase over RPC. Always aged.
#
# usedPercent is a FLOAT over RPC ("74.318..."). Every consumer of these columns
# is bash integer math ($(( 100 - used ))), which aborts the arithmetic on a
# fractional operand and silently leaves the risk flag at 0. So both readers
# floor it here, the way grok_row already does.
#
# primary/secondary are NOT reliably 5h/weekly: server's 46-day-old snapshot has
# primary = the 10080-minute (weekly) window and no secondary at all. So both
# readers bucket by the window DURATION (<= 600 min is the burst cap, above it is
# the weekly budget), never by slot name. Getting this wrong labelled a stale
# weekly reading as "71% of the 5h window".
codex_jsonl() {
  local best="" bt=0 f m
  # -print0 + read -d '': a codex rollout path with a space in it (a session
  # started from a directory like "~/My Stuff") would otherwise word-split into
  # two nonexistent paths and the whole fallback would come up empty.
  while IFS= read -r -d '' f; do
    m=$(mtime_of "$f"); [ "${m:-0}" -gt "$bt" ] 2>/dev/null || continue
    grep -q '"rate_limits"' "$f" 2>/dev/null || continue
    bt=$m; best=$f
  done < <(find "$HOME/.codex/sessions" "$HOME"/.codex/*/sessions -name '*.jsonl' -type f -print0 2>/dev/null)
  [ -n "$best" ] || return 1
  local line
  line=$(grep '"rate_limits"' "$best" | tail -1)
  [ -n "$line" ] || return 1
  printf '%s\t%s\n' "$bt" "$line"
}

codex_row() {   # -> TSV: five_pct five_reset weekly_pct weekly_reset source age
  local r
  if r=$(codex_rpc); then
    echo "$r" | jq -r '.result.rateLimits
      | [ (.primary // empty), (.secondary // empty) ]
      | { five:   (map(select((.windowDurationMins // 0) <= 600))    | first),
          weekly: (map(select((.windowDurationMins // 0)  > 600))    | first) }
      | [ ((.five.usedPercent   | if . == null then "-" else floor end)), (.five.resetsAt   // "-"),
          ((.weekly.usedPercent | if . == null then "-" else floor end)), (.weekly.resetsAt // "-"),
          "app-server", 0, "-" ] | @tsv' 2>/dev/null && return 0
  fi
  local fb bt line
  if fb=$(codex_jsonl); then
    bt=${fb%%$'\t'*}; line=${fb#*$'\t'}
    echo "$line" | jq -r --argjson age "$(( NOW - bt ))" '
      (.. | objects | select(has("rate_limits")) | .rate_limits) as $r
      | [ ($r.primary // empty), ($r.secondary // empty) ]
      | { five:   (map(select((.window_minutes // 0) <= 600)) | first),
          weekly: (map(select((.window_minutes // 0)  > 600)) | first) }
      | [ ((.five.used_percent   | if . == null then "-" else floor end)), (.five.resets_at   // "-"),
          ((.weekly.used_percent | if . == null then "-" else floor end)), (.weekly.resets_at // "-"),
          "session-jsonl", $age, "-" ] | @tsv' 2>/dev/null | head -1 && return 0
  fi
  printf 'ERR\tno live RPC (token expired?) and no rate_limits event on disk\n'
  return 1
}

# ---------------------------------------------------------------------------
# Grok: weekly credit pool only, no 5h window. The CLI logs its own billing
# fetch, so the newest `billing: fetched credits config` line is the truth as of
# that line's timestamp. Age matters here more than anywhere: the log only moves
# when the owner actually runs grok.
# ---------------------------------------------------------------------------
grok_row() {    # -> TSV: five_pct five_reset weekly_pct weekly_reset source age
  local log="$HOME/.grok/logs/unified.jsonl" line
  [ -r "$log" ] || { printf 'ERR\tno %s\n' "$log"; return 1; }
  line=$(grep 'creditUsagePercent' "$log" 2>/dev/null | tail -1)
  [ -n "$line" ] || { printf 'ERR\tno creditUsagePercent line in %s\n' "$log"; return 1; }
  echo "$line" | jq -r '
    (.ctx.config.creditUsagePercent // .ctx.config.credit_usage_percent) as $p
    | (.ctx.config.currentPeriod.end // .ctx.config.billingPeriodEnd) as $e
    | [ "-", "-",
        (if $p == null then "-" else ($p | floor) end),
        (if $e == null then "-" else ($e | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdate) end),
        "unified.jsonl",
        (now - (.ts | sub("\\.[0-9]+"; "") | fromdateiso8601) | floor),
        "-" ] | @tsv' 2>/dev/null
}

# ---------------------------------------------------------------------------
# Collect.
#
# One row per pool, tab-delimited, in a fixed 10-field shape:
#   pool five five_reset weekly weekly_reset source age risk reason note
#
# "-" means "this pool has no such number" and is carried ALL THE WAY through to
# the renderers. It is not cosmetic: a tab is IFS-whitespace, so a genuinely
# empty field collapses on `read` and shifts every later column left. grok (no
# 5h window) and the old server codex snapshot (no secondary) both hit that.
# nz() is the single place that turns the placeholder back into "missing".
# ---------------------------------------------------------------------------
ROWS=()
nz() { [ "${1:-}" = "-" ] && echo "" || echo "${1:-}"; }

add_row() {  # $1 = pool, $2 = producer TSV (or "ERR<TAB>reason")
  local pool="$1" tsv="${2:-}"
  if [ -z "$tsv" ] || [ "${tsv%%$'\t'*}" = "ERR" ]; then
    local why="${tsv#ERR$'\t'}"; [ "$why" = "$tsv" ] && why="no data"
    ROWS+=("$pool"$'\t'-$'\t'-$'\t'-$'\t'-$'\t'unavailable$'\t'-$'\t'0$'\t'-$'\t'"$why")
    return
  fi
  local f5 f5r w7 w7r src age st
  IFS=$'\t' read -r f5 f5r w7 w7r src age st <<< "$tsv"
  local rk; rk=$(risk_of "$(nz "$w7")" "$(nz "$w7r")" "${age:-0}")
  local risk="${rk%%$'\t'*}" reason="${rk#*$'\t'}"
  [ -z "$reason" ] && reason="-"
  local note="-" stv; stv=$(nz "${st:-}")
  [ -n "$stv" ] && [ "$stv" != "?" ] && [ "$stv" != "allowed" ] && note="status=$stv"
  ROWS+=("$pool"$'\t'"${f5:--}"$'\t'"${f5r:--}"$'\t'"${w7:--}"$'\t'"${w7r:--}"$'\t'"${src:--}"$'\t'"${age:-0}"$'\t'"${risk:-0}"$'\t'"$reason"$'\t'"$note")
}

for l in work personal team-a team-owner; do
  [ -r "$ACCT_DIR/$l" ] || continue
  add_row "claude $l" "$(claude_row "$l")"
done
add_row "codex" "$(codex_row)"
add_row "grok"  "$(grok_row)"

# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------
if [ "$JSON" = 1 ]; then
  {
    printf '{"host":"%s","now":%s,"pools":[' "$HOST_NAME" "$NOW"
    first=1
    for row in "${ROWS[@]}"; do
      IFS=$'\t' read -r pool f5 f5r w7 w7r src age risk reason note <<< "$row"
      f5=$(nz "$f5"); f5r=$(nz "$f5r"); w7=$(nz "$w7"); w7r=$(nz "$w7r")
      reason=$(nz "$reason"); note=$(nz "$note"); age=$(nz "$age")
      [ $first -eq 0 ] && printf ','
      first=0
      jq -nc \
        --arg pool "$pool" --arg src "$src" --arg reason "$reason" --arg note "$note" \
        --argjson five "${f5:-null}" --argjson five_reset "${f5r:-null}" \
        --argjson weekly "${w7:-null}" --argjson weekly_reset "${w7r:-null}" \
        --argjson age "${age:-null}" \
        --argjson risk "$([ "${risk:-0}" = 1 ] && echo true || echo false)" \
        --arg five_reset_ist "$(ist "$f5r")" --arg weekly_reset_ist "$(ist "$w7r")" \
        --argjson now "$NOW" \
        '{"pool":$pool,"five_pct":$five,"five_reset":$five_reset,"five_reset_ist":$five_reset_ist,
          "weekly_pct":$weekly,"weekly_reset":$weekly_reset,"weekly_reset_ist":$weekly_reset_ist,
          "weekly_remaining_pct":(if $weekly==null then null else (100-$weekly) end),
          "hours_left":(if $weekly_reset==null then null else ([($weekly_reset-$now)/3600|floor,0]|max) end),
          "windows_left":(if $weekly_reset==null then null else ([($weekly_reset-$now)/18000|floor,0]|max) end),
          "source":$src,"age_s":$age,"at_risk":$risk,"risk_reason":$reason,"note":$note}'
    done
    printf ']}'
  } | tr -d '\n'
  echo
  exit 0
fi

FMT='%-16s %-18s %-37s %-13s %-24s %s\n'
printf 'QUOTA  %s  %s\n\n' "$HOST_NAME" "$(TZ=$IST_TZ date '+%a %d %b %H:%M IST')"
# shellcheck disable=SC2059
printf "$FMT" POOL 5H WEEKLY WINDOWS-LEFT SOURCE FLAG
printf "$FMT" "----" "--" "------" "------------" "------" "----"
risky=0
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r pool f5 f5r w7 w7r src age risk reason note <<< "$row"
  f5=$(nz "$f5"); f5r=$(nz "$f5r"); w7=$(nz "$w7"); w7r=$(nz "$w7r")
  reason=$(nz "$reason"); note=$(nz "$note")
  if [ "$src" = "unavailable" ]; then
    printf "$FMT" "$pool" "-" "-" "-" "unavailable" "$note"
    continue
  fi
  fivec="-"
  if [ -n "$f5" ]; then
    # "used" is explicit on every percent here and in the bot render: a bare
    # "100%" read as ambiguous (spent, or left?) the first time the owner saw grok.
    fivec="${f5}% used"
    [ -n "$f5r" ] && fivec="${fivec} +$(dur $(( ${f5r%.*} - NOW )) )"
  fi
  wcol="-"; wlc="-"
  if [ -n "$w7" ]; then
    wcol="${w7}% used"
    if [ -n "$w7r" ]; then
      wcol="${wcol}, ends $(ist "$w7r")"
      wl=$(( (${w7r%.*} - NOW) / 18000 )); [ "$wl" -lt 0 ] && wl=0
      wlc="${wl} x 5h"
    fi
  fi
  srcc="$src"
  [ "${age:-0}" -gt 0 ] && srcc="$src ($(dur "$age") old)"
  flag=""
  if [ "$risk" = 1 ]; then flag="WILL LOSE: $reason"; risky=1
  elif [ -n "$reason" ]; then flag="$reason"; fi
  [ -n "$note" ] && flag="${flag:+$flag; }$note"
  printf "$FMT" "$pool" "$fivec" "$wcol" "$wlc" "$srcc" "$flag"
done

echo
if [ "$risky" = 1 ]; then
  echo "5h is a burst cap; weekly is the budget. A flagged pool has more budget left"
  echo "than the remaining time can absorb: park work onto it now or it expires."
  echo "Parked queue: ~/monorepo/team/parked-work.md"
else
  echo "No pool is on track to waste its weekly budget."
fi
