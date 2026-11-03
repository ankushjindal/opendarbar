#!/usr/bin/env bash
# oat-probe.sh — longevity test for the setup-tokens (long-lived CLAUDE_CODE_OAUTH_TOKEN).
#
# THE QUESTION: does a `claude setup-token` grant survive a long IDLE gap (the
# thing that expired our normal ~8h OAuth grant overnight on 2026-07-07), or does
# it lapse the same way? If it survives, we migrate the fleet to setup-tokens and
# drop the keepalive; if it lapses, we keep the file-swap toggle + keepalive.
#
# Probes EVERY account token in creds-store (oat-<label>.txt) — work AND personal.
# Personal was unprobed until 2026-07-10, so a fleet flip to personal was a leap of
# faith (P0-6); now both are validated independently, each with its own verdict.
#
# DESIGN NOTE (why the timer skips the night): each probe USES the token, which
# could refresh a usage-based grant and mask an idle-expiry. So the timer fires
# only during the day and deliberately leaves an ~8h overnight gap with NO probe.
# The morning probe, after that untouched gap, is the decisive datapoint. The
# fleet itself never touches these tokens between probes (it runs on the shared
# grant / oat-active), so between probes each setup-token is genuinely idle.
#
# Logs PASS/FAIL + token age + gap-since-last-probe per label to oat-probe.log,
# and pings the owner once per label with the verdict (first FAIL, or 20h+ all-PASS).
set -uo pipefail

B=/home/owner
STORE=$B/.claude/creds-store
LOG=$B/kai/logs/oat-probe.log
STATE_DIR=$B/kai/state
PROBE_HOME=/tmp/oat-probe-home
ALERT_CHAT="${OWNER_CHAT_ID:-}"
mkdir -p "$(dirname "$LOG")" "$STATE_DIR" "$PROBE_HOME"

# systemd units run with a bare PATH — claude lives in ~/.local/bin. Without
# this, the probe exits 127 (command not found), which v1 mis-classified as an
# auth FAIL and fired a false "NOT durable" verdict (2026-07-07 06:00 incident).
export PATH="$B/.local/bin:/usr/local/bin:/usr/bin:/bin"
CLAUDE_BIN="$B/.local/bin/claude"
[ -x "$CLAUDE_BIN" ] || CLAUDE_BIN=$(command -v claude || true)

now=$(date +%s)
tstamp() { date -u +%FT%TZ; }
alert() {
  local tok; tok=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K.*' "$B/.claude/channels/telegram/.env" 2>/dev/null | head -1)
  [ -z "$tok" ] && return 0
  curl -sS -m 10 "https://api.telegram.org/bot${tok}/sendMessage" -d chat_id="$ALERT_CHAT" \
    --data-urlencode text="$1" >/dev/null 2>&1 || true
}

[ -z "$CLAUDE_BIN" ] && { echo "$(tstamp) INFRA no claude binary on PATH" >> "$LOG"; exit 0; }

probe_token() { # label tokfile
  local label="$1" tokfile="$2"
  local STATE="$STATE_DIR/oat-probe-$label.state"
  local LASTTS="$STATE_DIR/oat-probe-$label.lastts"
  local VERDICT="$STATE_DIR/oat-probe-$label.verdict"

  [ -f "$tokfile" ] || { echo "$(tstamp) [$label] NO_TOKEN_FILE" >> "$LOG"; return 0; }
  local TOK; TOK=$(tr -d '[:space:]' < "$tokfile")
  [ -n "$TOK" ] || { echo "$(tstamp) [$label] EMPTY_TOKEN" >> "$LOG"; return 0; }

  local created age_h last gap_h
  created=$(stat -c %Y "$tokfile" 2>/dev/null || echo "$now")
  age_h=$(( (now - created) / 3600 ))
  last=$(cat "$LASTTS" 2>/dev/null || echo "$created")
  gap_h=$(( (now - last) / 3600 ))

  # headless auth probe — clean HOME so no plugins/MCP load; token via env overrides
  # any credentials file (precedence). </dev/null so it doesn't wait on stdin.
  local out rc result
  out=$(HOME="$PROBE_HOME" CLAUDE_CODE_OAUTH_TOKEN="$TOK" timeout 90 \
          "$CLAUDE_BIN" -p "Reply with the single word: OK" --model haiku </dev/null 2>&1)
  rc=$?

  # Classify — ONLY a real auth rejection counts against the token. Everything
  # else (binary missing = 127, timeout = 124, network flake, API 5xx/overload)
  # is an INFRA result: logged, no verdict, no state change.
  if [ $rc -eq 0 ] && echo "$out" | grep -qi '\bOK\b'; then
    result=PASS
  elif echo "$out" | grep -qiE 'invalid authentication|authentication[_ ]error|401|OAuth token (is )?(invalid|expired|revoked)|please run /login|credential' ; then
    result=FAIL
  else
    echo "$(tstamp) [$label] INFRA rc=$rc out=$(echo "$out" | tail -1 | cut -c1-160)" >> "$LOG"
    return 0
  fi

  echo "$(tstamp) [$label] $result age=${age_h}h gap=${gap_h}h rc=$rc" >> "$LOG"
  echo "$now" > "$LASTTS"
  echo "$result" > "$STATE"

  # ── verdict (one-shot per label) ─────────────────────────────────────────
  if [ ! -f "$VERDICT" ]; then
    if [ "$result" = "FAIL" ]; then
      alert "⚠️ setup-token longevity — VERDICT [$label]: NOT durable. The $label setup-token FAILED a probe after ~${age_h}h (gap ${gap_h}h since last use). Same lapse class as normal OAuth. Log: ~/kai/logs/oat-probe.log"
      touch "$VERDICT"
    elif [ "$result" = "PASS" ] && [ "$age_h" -ge 20 ] && [ "$gap_h" -ge 7 ]; then
      alert "✅ setup-token longevity — VERDICT [$label]: DURABLE. The $label setup-token survived ~${age_h}h including a ${gap_h}h untouched idle gap. Safe to run the fleet on $label. Log: ~/kai/logs/oat-probe.log"
      touch "$VERDICT"
    fi
  fi
}

# Probe every account token in the store (work, personal, …).
shopt -s nullglob
for tokfile in "$STORE"/oat-*.txt; do
  base=$(basename "$tokfile")               # oat-<label>.txt
  [ "$base" = "oat-active.txt" ] && continue # symlink to the active one; skip the dup
  label=${base#oat-}; label=${label%.txt}
  probe_token "$label" "$tokfile"
done
