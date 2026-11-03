#!/usr/bin/env bash
# mac-account-switch.sh <agent> <label> [chat_id]
#
# Per-session account switch on the MAC. The sibling of server's
# account-switch.sh, and it exists because the two machines are shaped
# differently:
#
#   server  one HOME per son -> fleet-ctl can resume by scanning that HOME's
#           newest transcript, and FLEETCTL_OAT_OVERRIDE injects the token.
#   mac     every agent shares ~/.claude -> "newest transcript in $HOME" is
#           whichever son typed last, not this one. macctl gave up and forces
#           --fresh for shared-HOME agents. That is fine for a crash heal and
#           WRONG for an account switch: the owner asked for the conversation to
#           survive the swap.
#
# So this script takes the session id from the horse's mouth: the live claude
# process's own argv (`-r <sid>` / `--resume <sid>`), which claude keeps stable
# across a resume. Kill the pane, relaunch the SAME registry spawn with that id
# plus the target account's token, and the son wakes up mid-conversation on the
# other account.
#
# Token handling: the path is passed to the tmux command, `cat`-ed INSIDE the
# spawned shell. The secret never enters this script's argv, this script's
# output, or the log. Same trick the dashboard's dcg spawn uses.
#
# Quiet + confirmed, like server's: a quiet-restart marker suppresses the
# lifecycle notice, an account-switched marker makes the successor post one
# "back on <label>" line, and a maint flag keeps `macctl ensure` off the boot
# window. Detached (nohup + disown) so it survives the tmux kill it performs.
#
# Busy guard: a switch KILLS the pane, and killing a pane mid-turn throws away
# the work in flight (the turn is not replayed on resume, it is simply gone). So
# a pane that is visibly mid-turn is refused with exit 3 unless --force. The
# dashboard turns that 3 into a second confirm; kushbot's /account has no force
# path at all, because "kill the turn" is not a decision to take from a chat.
#
#   ./mac-account-switch.sh slot4 work <OWNER_CHAT_ID>
#   ./mac-account-switch.sh kc personal
#   ./mac-account-switch.sh --force slot4 work      # kill the live turn too
#   ./mac-account-switch.sh --dry-run slot4 work    # print the plan, touch nothing
#
# exit 0 ok / scheduled   1 bad input or bad state   3 the pane is busy mid-turn
set -uo pipefail

DRY=0
FORCE=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --dry-run) DRY=1; shift ;;
    --force)   FORCE=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done
AGENT="${1:?usage: mac-account-switch.sh [--dry-run] [--force] <agent> <label> [chat_id]}"
LABEL="${2:?label}"
CHAT="${3:-}"

REG="$HOME/.claude/channels/fleet/registry.json"
STATE_DIR="$HOME/.claude/channels/fleet/state"
LOG="$HOME/.claude/channels/fleet/logs/mac-account-switch.log"
KUSHBOTS="$HOME/.claude/channels/kushbots"
TOK="$HOME/.config/claude-accounts/$LABEL"
TMUX_BIN="$(command -v tmux || echo /usr/local/bin/tmux)"
SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")"
mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
die() { echo "$1"; log "ABORT $AGENT -> $LABEL: $1"; exit 1; }

case "$AGENT" in *[!a-zA-Z0-9._-]*) die "bad agent name" ;; esac
case "$LABEL" in *[!a-zA-Z0-9._-]*) die "bad label" ;; esac
case "$CHAT" in *[!0-9-]*) die "bad chat id" ;; esac

[ -r "$REG" ] || die "no registry at $REG"
[ -s "$TOK" ] || die "no token for '$LABEL' (expected a non-empty $TOK)"

ENTRY=$(jq -c --arg n "$AGENT" '.agents[] | select(.machine == "laptop" and .name == $n)' "$REG" 2>/dev/null | head -1)
[ -n "$ENTRY" ] || die "'$AGENT' is not a laptop agent in the registry"
TMUXS=$(echo "$ENTRY" | jq -r '.tmux // empty'); TMUXS="${TMUXS:-$AGENT}"
CWD=$(echo "$ENTRY" | jq -r '.cwd // empty');    CWD="${CWD:-$HOME}"
SPAWN=$(echo "$ENTRY" | jq -r '.spawn // empty')
SLOT=$(echo "$ENTRY" | jq -r '.slot // empty')
[ -n "$SPAWN" ] || die "'$AGENT' has no spawn command in the registry"

# Slot: an explicit registry field wins (reddit-hunter), else the spawn's own
# KUSHBOT_AUTO_ATTACH. Only used for the claim file + the markers, so an agent
# with neither still switches, it just gets no TG confirmation.
if [ -z "$SLOT" ]; then
  SLOT=$(echo "$SPAWN" | sed -n 's/.*KUSHBOT_AUTO_ATTACH=\([0-9][0-9]*\).*/\1/p' | head -1)
fi
CLAIM=""
[ -n "$SLOT" ] && CLAIM="$KUSHBOTS/slot$SLOT/claimed_by.pid"

# --- the session id, from the live process ---------------------------------
# Pane pid -> its claude child -> that child's argv. Falls back to the id baked
# into the registry spawn (a son that has never been re-pointed), then to a
# fresh boot, which we say out loud rather than pretending it resumed.
sid_from_argv() {
  local pp cp args
  "$TMUX_BIN" has-session -t "$TMUXS" 2>/dev/null || return 1
  pp=$("$TMUX_BIN" list-panes -t "$TMUXS" -F '#{pane_pid}' 2>/dev/null | head -1)
  [ -n "$pp" ] || return 1
  # The pane pid ITSELF first. A son launched by fleet-up.sh (send-keys into a
  # zsh) has claude as a child; one launched by this script has tmux exec claude
  # as the pane process. Checking only children made the second switch in a row
  # fall back to the registry spawn, which for kc and slot4 carries no resume id
  # at all, so it would have booted them FRESH.
  for cp in "$pp" $(pgrep -P "$pp" 2>/dev/null); do
    args=$(ps -o command= -p "$cp" 2>/dev/null)
    # Match the BINARY, not the substring. The kushbot MCP child's argv carries
    # the plugin path under ~/.claude, so a bare *claude* test picks IT, and the
    # switch then resumes whatever id that argv happens to hold (usually none,
    # i.e. a FRESH session). Same rule the dashboard uses (fleet-mac.ts).
    echo "$args" | grep -qE '(^|/)claude([[:space:]]|$)' || continue
    echo "$args" | sed -nE 's/.*(-r|--resume) ([0-9a-f-]{36}).*/\2/p' | head -1
    return 0
  done
  return 1
}
SID=$(sid_from_argv || true)
SID_SRC="live argv"
if [ -z "$SID" ]; then
  SID=$(echo "$SPAWN" | sed -nE 's/.*(-r|--resume) ([0-9a-f-]{36}).*/\2/p' | head -1)
  SID_SRC="registry spawn"
fi
[ -n "$SID" ] || SID_SRC="none (FRESH session)"

# --- busy guard ------------------------------------------------------------
# Is the pane mid-turn? Claude prints one status line while a turn is in flight:
#
#   ✻ Quantumizing… (37s · ↑ 1.4k tokens · esc to interrupt)
#
# The verb is random and the spinner cycles frames, so match the parts that do
# not move: the literal "esc to interrupt", the "tokens ·" of the same line, and
# as a backstop any spinner glyph followed by a word and the ellipsis. Flattened
# capture, because at a narrow width that line wraps.
pane_busy() {
  local pane
  "$TMUX_BIN" has-session -t "$TMUXS" 2>/dev/null || return 1
  pane=$("$TMUX_BIN" capture-pane -t "$TMUXS" -p -J -S -25 2>/dev/null | tr '\n' ' ')
  [ -n "$pane" ] || return 1
  case "$pane" in
    *"esc to interrupt"*) return 0 ;;
    *"tokens ·"*)         return 0 ;;
  esac
  # hyphens included: the verbs run to "Razzle-dazzling…" as well as "Crafting…"
  printf '%s' "$pane" | grep -qE '(✻|✽|✶|✳|✢|✱) *[A-Za-z][A-Za-z-]*…' && return 0
  return 1
}
BUSY=0
pane_busy && BUSY=1

# --- relaunch command ------------------------------------------------------
# Strip any resume already in the spawn, re-add ours right after
# --dangerously-skip-permissions (variadic flags after it would swallow the id).
#
# The account env has to go too. Since the durability write below bakes
# CLAUDE_ACCT_LABEL + CLAUDE_CODE_OAUTH_TOKEN INTO the registry spawn, a second
# switch would otherwise produce
#   CLAUDE_ACCT_LABEL=new ... CLAUDE_ACCT_LABEL=old ... claude
# and in a shell command prefix the LAST assignment wins, so the son would come
# back on the account it was just moved off. (macctl strips the same two.)
SQ="'"
RELAUNCH=$(echo "$SPAWN" \
  | sed -E "s/CLAUDE_CODE_OAUTH_TOKEN=\"\\\$\\(cat ${SQ}[^${SQ}]*${SQ}\\)\" *//g" \
  | sed -E 's/CLAUDE_CODE_OAUTH_TOKEN=[^ ]+ *//g' \
  | sed -E 's/CLAUDE_ACCT_LABEL=[^ ]+ *//g' \
  | sed -E 's/ (-r|--resume) [^ ]+//g')
if [ -n "$SID" ]; then
  case "$RELAUNCH" in
    *--dangerously-skip-permissions*)
      RELAUNCH="${RELAUNCH/--dangerously-skip-permissions/--dangerously-skip-permissions -r $SID}" ;;
    *) RELAUNCH="$RELAUNCH -r $SID" ;;
  esac
fi
# Token read inside the spawned shell: never in argv, never in this log.
CMD="CLAUDE_ACCT_LABEL=$LABEL CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$TOK')\" $RELAUNCH"

if [ "$DRY" -eq 1 ]; then
  echo "would switch $AGENT -> $LABEL"
  echo "  tmux    : $TMUXS   (cwd $CWD)"
  echo "  slot    : ${SLOT:-none}   claim ${CLAIM:-none}"
  echo "  session : ${SID:-FRESH}   (from $SID_SRC)"
  echo "  busy    : $([ "$BUSY" -eq 1 ] && echo "YES, a turn is in flight (would refuse without --force)" || echo "no")"
  echo "  token   : $TOK   (read inside the spawned shell, never printed)"
  echo "  command : ${CMD/CLAUDE_CODE_OAUTH_TOKEN=*\" /CLAUDE_CODE_OAUTH_TOKEN=<from token file> }"
  [ "$BUSY" -eq 1 ] && [ "$FORCE" -eq 0 ] && exit 3
  exit 0
fi

if [ "$BUSY" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  echo "REFUSED: $AGENT is mid-turn right now (tmux $TMUXS). Switching kills the pane, and the work in that turn is lost, not resumed. Wait for it to finish, or re-run with --force."
  log "REFUSED $AGENT -> $LABEL: pane busy mid-turn"
  exit 3
fi
[ "$BUSY" -eq 1 ] && log "FORCED $AGENT -> $LABEL over a live turn"

now=$(date +%s)
echo $(( now + 240 )) > "$STATE_DIR/maint-$AGENT"
if [ -n "$SLOT" ] && [ -d "$KUSHBOTS/slot$SLOT" ]; then
  echo $(( now + 240 )) > "$KUSHBOTS/slot$SLOT/quiet-restart" 2>/dev/null || true
  if [ -n "$CHAT" ]; then
    printf '{"label":"%s","chat_id":"%s"}\n' "$LABEL" "$CHAT" \
      > "$KUSHBOTS/slot$SLOT/account-switched" 2>/dev/null || true
  fi
fi

log "scheduling $AGENT -> $LABEL (tmux $TMUXS, slot ${SLOT:-none}, session ${SID:-fresh} via $SID_SRC)"

DELAY="${ACCOUNT_SWITCH_DELAY:-3}"
nohup bash -c '
  set -uo pipefail
  AGENT="$1"; LABEL="$2"; TMUXS="$3"; CWD="$4"; CMD="$5"; CLAIM="$6"
  DELAY="$7"; LOG="$8"; STATE_DIR="$9"; TMUX_BIN="${10}"; REG="${11}"; SID="${12}"
  SEND_SH="$HOME/.claude/channels/kushbots/slot0/send.sh"
  ALERT_CHAT="${OWNER_CHAT_ID:-}"
  SWITCH_SH="${13}"
  log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

  # Durability. A switch that only rewrites the tmux command lasts until the
  # next `macctl ensure` heal, which relaunches from the registry spawn and puts
  # the son back on whatever account that line carried. So on success we write
  # the switch INTO the registry: acct=<label> (macctl injects the token for it)
  # and a spawn that is self-sufficient (label + token read + -r <sid>). jq to a
  # temp file then mv, so a torn write cannot leave the fleet without a roster.
  reg_record() {
    local tmp
    [ -r "$REG" ] || { log "registry $REG unreadable, acct NOT recorded"; return 1; }
    tmp=$(mktemp "${REG}.XXXXXX") || return 1
    if jq --arg n "$AGENT" --arg a "$LABEL" --arg s "$CMD" \
         "(.agents[] | select(.machine == \"laptop\" and .name == \$n)) |= (.acct = \$a | .spawn = \$s)" \
         "$REG" > "$tmp" 2>/dev/null && [ -s "$tmp" ] \
       && [ "$(jq -r --arg n "$AGENT" '"'"'[.agents[] | select(.name == $n)] | length'"'"' "$tmp" 2>/dev/null)" != "0" ]; then
      chmod "$(stat -f %Lp "$REG" 2>/dev/null || echo 600)" "$tmp" 2>/dev/null || true
      mv "$tmp" "$REG" && { log "registry: $AGENT acct=$LABEL, spawn re-pointed"; return 0; }
    fi
    rm -f "$tmp"; log "registry write FAILED for $AGENT (left untouched)"; return 1
  }
  sleep "$DELAY"
  log "firing $AGENT -> $LABEL"

  # kill: harvest the pane children first (claude reparents to init on a Mac
  # tmux kill, so after the kill there is nothing left to match on).
  cps=""
  if "$TMUX_BIN" has-session -t "$TMUXS" 2>/dev/null; then
    pp=$("$TMUX_BIN" list-panes -t "$TMUXS" -F "#{pane_pid}" 2>/dev/null | head -1)
    [ -n "$pp" ] && cps=$(pgrep -P "$pp" 2>/dev/null | tr "\n" " ")
    "$TMUX_BIN" kill-session -t "$TMUXS" 2>/dev/null && log "killed tmux $TMUXS"
  fi
  sleep 1
  for p in $cps; do kill -0 "$p" 2>/dev/null && kill "$p" 2>/dev/null && log "reaped $p"; done
  if [ -n "$CLAIM" ] && [ -f "$CLAIM" ]; then
    cpid=$(cat "$CLAIM" 2>/dev/null || true)
    if [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null; then kill "$cpid" 2>/dev/null && log "reaped poller $cpid"; fi
    sleep 1
    cpid=$(cat "$CLAIM" 2>/dev/null || true)
    if [ -z "$cpid" ] || ! kill -0 "$cpid" 2>/dev/null; then rm -f "$CLAIM"; log "cleared dead claim"; fi
  fi
  sleep 1

  "$TMUX_BIN" new-session -d -s "$TMUXS" -c "$CWD" "$CMD" || { log "tmux new-session FAILED"; exit 1; }
  log "relaunched $TMUXS on $LABEL"

  # boot prompts, matched on FLATTENED pane text so wrapping cannot hide one.
  waited=0
  while [ $waited -lt 60 ]; do
    sleep 3; waited=$((waited+3))
    pane=$("$TMUX_BIN" capture-pane -t "$TMUXS" -p -S -40 2>/dev/null | tr "\n" " ")
    if echo "$pane" | grep -q "bypass permissions on"; then break
    elif echo "$pane" | grep -q "WARNING: Claude Code running in Bypass Permissions"; then
      # this dialog DEFAULTS to "1. No, exit", so a blind Enter kills claude.
      "$TMUX_BIN" send-keys -t "$TMUXS" 2; sleep 1; "$TMUX_BIN" send-keys -t "$TMUXS" Enter
    elif echo "$pane" | grep -qE "Is this a project you created|local development|Loading development channels|Please use --channels|Resume from summary|Press Enter to continue|Security notes"; then
      "$TMUX_BIN" send-keys -t "$TMUXS" Enter
    fi
  done

  ok=0
  if [ -n "$CLAIM" ]; then
    for i in 1 2 3 4 5 6 7 8; do
      sleep 4
      cpid=$(cat "$CLAIM" 2>/dev/null || true)
      if [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null; then ok=1; break; fi
    done
  else
    "$TMUX_BIN" has-session -t "$TMUXS" 2>/dev/null && ok=1
  fi
  if [ $ok -eq 1 ]; then
    rm -f "$STATE_DIR/maint-$AGENT"
    reg_record || true
    log "DONE $AGENT is up on $LABEL"
  else
    log "FAILED $AGENT did not verify up on $LABEL (tmux attach -t $TMUXS)"
    # no false "back on <label>" from a switch that never came up
    [ -n "$CLAIM" ] && rm -f "$(dirname "$CLAIM")/account-switched" 2>/dev/null || true

    # A failed switch leaves the son DOWN, and the maint flag it was scheduled
    # with expires 240s later. `macctl ensure` then finds a dead agent, relaunches
    # it, and for a shared-HOME slot with no recorded sid that relaunch is
    # --fresh: the conversation this whole script exists to preserve, thrown away
    # by the watchdog four minutes after we gave up. So hold ensure off for 30
    # minutes and tell a human, because nothing else is going to.
    echo $(( $(date +%s) + 1800 )) > "$STATE_DIR/maint-$AGENT" 2>/dev/null || true
    log "maint-$AGENT held 30m so ensure cannot heal it --fresh"
    if [ -x "$SEND_SH" ]; then
      # Double quotes and real newlines only: a single quote anywhere in here
      # would close the outer bash -c string this whole block lives in.
      msg="ACCOUNT SWITCH FAILED: $AGENT did not come back up on $LABEL.

It is DOWN right now. macctl ensure is held off for 30 min, because its heal would boot $AGENT fresh and lose the conversation.

Look:  tmux attach -t $TMUXS
Retry: $SWITCH_SH --force $AGENT $LABEL
Session to resume: ${SID:-none recorded, so a retry would boot it FRESH}"
      "$SEND_SH" "$ALERT_CHAT" "$msg" >/dev/null 2>&1 \
        && log "alerted $ALERT_CHAT" || log "alert to $ALERT_CHAT FAILED"
    else
      log "no send path at $SEND_SH, nobody was told"
    fi
  fi
' _ "$AGENT" "$LABEL" "$TMUXS" "$CWD" "$CMD" "$CLAIM" "$DELAY" "$LOG" "$STATE_DIR" "$TMUX_BIN" "$REG" "$SID" "$SELF" \
  </dev/null >>"$LOG" 2>&1 &
disown 2>/dev/null || true

echo "account-switch scheduled: $AGENT -> $LABEL in ${DELAY}s (detached; resuming ${SID:-a FRESH session} from $SID_SRC)"
