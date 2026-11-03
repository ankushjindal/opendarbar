#!/usr/bin/env bash
# self-restart.sh <agent> — let a running fleet agent restart ITSELF.
#
# The problem: `fleet-ctl start <self>` kills the agent's own tmux session,
# which kills the very process that ran it — so the relaunch never happens.
# The fix: detach the restart from the caller's process tree with setsid +
# nohup, sleep briefly so the caller's turn can finish cleanly, THEN kill +
# relaunch. The detached child is reparented to init and survives the session
# death, so it completes the relaunch.
#
# Resume is the default (fleet-ctl start with no --fresh), so the agent comes
# back on the SAME session — you're mid-conversation, the fresh process
# resumes your transcript.
#
# Usage (from inside the agent, or anywhere):
#   ~/kai/self-restart.sh kai4          # resume-restart kai4 in ~4s, detached
#   ~/kai/self-restart.sh kai4 --fresh  # fresh session instead
set -uo pipefail
AGENT="${1:?usage: self-restart.sh <agent> [--fresh]}"
FRESH="${2:-}"
DELAY="${SELF_RESTART_DELAY:-4}"
LOG=/home/owner/kai/logs/self-restart.log
mkdir -p "$(dirname "$LOG")"

# Fully detach: setsid gives a new session (no controlling tty), nohup ignores
# SIGHUP, and </dev/null >>log 2>&1 severs all three std streams from the
# dying pane. The subshell sleeps past the caller's turn, then relaunches.
# Quiet by default: a self-restart is always planned, so suppress both the
# watchdog (maint flag) and the bot's own red/green lifecycle notices (quiet
# marker — detach leaves it, the successor's attach consumes it; see
# server.ts notifyLifecycle).
AGENT_HOME=$(jq -r --arg n "$AGENT" '.agents[] | select(.name == $n) | .home // empty' /home/owner/.claude/channels/fleet/registry.json 2>/dev/null || true)
mkdir -p /home/owner/kai/state
echo $(( $(date +%s) + 180 )) > "/home/owner/kai/state/maint-$AGENT"
if [ -n "$AGENT_HOME" ]; then
  echo $(( $(date +%s) + 180 )) > "$AGENT_HOME/.claude/channels/telegram/quiet-restart" 2>/dev/null || true
fi

# Dead-claim sweep, belt to fleet-ctl's braces. claimed_by.pid is the poller's
# mutual-exclusion primitive: a successor that finds a claim it does not own will
# not poll, so it comes up DEAF and messages pile up at Telegram until the
# watchdog spots it. A resume-restart is the case that strands one, because the
# old poller is killed rather than shut down through detach(). Only a pid that
# fails kill -0 is cleared; a LIVE claim is left alone (the caller may still BE
# that claim at this point, and fleet-ctl clears it after the kill either way).
setsid nohup bash -c "
  sleep $DELAY
  echo \"\$(date -u +%FT%TZ) self-restart firing for $AGENT (fresh=${FRESH:-no})\" >> '$LOG'
  claim='${AGENT_HOME:-}/.claude/channels/telegram/claimed_by.pid'
  if [ -n '${AGENT_HOME:-}' ] && [ -f \"\$claim\" ]; then
    cpid=\$(cat \"\$claim\" 2>/dev/null || true)
    if [ -z \"\$cpid\" ] || ! kill -0 \"\$cpid\" 2>/dev/null; then
      rm -f \"\$claim\"
      echo \"\$(date -u +%FT%TZ) cleared dead claimed_by.pid (\${cpid:-empty}) for $AGENT\" >> '$LOG'
    fi
  fi
  /home/owner/kai/fleet-ctl start $AGENT $FRESH >> '$LOG' 2>&1
  echo \"\$(date -u +%FT%TZ) self-restart done for $AGENT\" >> '$LOG'
  rm -f \"/home/owner/kai/state/maint-$AGENT\"
" </dev/null >>"$LOG" 2>&1 &
disown 2>/dev/null || true
echo "self-restart scheduled for $AGENT in ${DELAY}s (detached). Watch: tail -f $LOG"
