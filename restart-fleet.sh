#!/usr/bin/env bash
#
# restart-fleet.sh — Mac-side fleet orchestration (the kushbot recovery layer).
#
# The Mac fleet is a POOL, not a set of daemons:
#   - slot0 = the always-on kc PARENT (@example_laptop_bot) — runs inside a tmux
#     session "kc", launched by the `kc`/`kct` zsh function. THE bot the owner DMs.
#   - slots 1-3 = ad-hoc SONS (@kush{1,2,3}_son_of_kush_bot), spawned on demand
#     by the kushbot `spawn` MCP tool inside whatever dc session needs telegram.
#     They are NOT persistent and are NOT restarted here — they come/go per task.
#
# So "restarting the Mac fleet" = ensuring the kc parent is alive. This is the
# Mac analog of server's ~/kai/restart-sons.sh, but parent-focused (server's
# script restarts SONS and leaves the parent to the owner; on the Mac the parent
# IS the fleet's always-on member).
#
# Usage:
#   ./restart-fleet.sh status     # show token + parent + pool state (default)
#   ./restart-fleet.sh up         # launch kc parent in detached tmux if not running
#   ./restart-fleet.sh restart    # recycle the kc parent (WIPES its session memory)
#
set -euo pipefail
CMD="${1:-status}"
CHAN="$HOME/.claude/channels/kushbots"

check_tokens() {
  echo "== tokens =="
  local miss=0
  for s in 0 1 2 3; do
    if [ -s "$CHAN/slot$s/.env" ]; then echo "  slot$s .env ✓"; else echo "  slot$s .env ✗ MISSING — restore the slot tokens (see RECOVERY.md)"; miss=1; fi
  done
  return $miss
}

parent_running() { tmux has-session -t kc 2>/dev/null; }

status() {
  check_tokens || true
  echo "== kc parent (slot0) =="
  if parent_running; then
    echo "  tmux session 'kc' ✓ running — attach: tmux attach -t kc"
  else
    echo "  tmux session 'kc' ✗ not running — start: ./restart-fleet.sh up   (or: kct)"
  fi
  echo "== pool (live MCP claim state) =="
  for s in 0 1 2 3; do
    pidf="$CHAN/slot$s/claimed_by.pid"
    if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
      echo "  slot$s: claimed (pid $(cat "$pidf"))"
    else
      echo "  slot$s: free"
    fi
  done
  echo "== sons =="
  echo "  ad-hoc — spawn on demand via kushbot 'spawn' tool. Nothing to restart here."
}

up() {
  if ! check_tokens; then echo "ABORT: restore tokens first (see RECOVERY.md)"; exit 1; fi
  if parent_running; then echo "kc parent already running. attach: tmux attach -t kc"; exit 0; fi
  command -v tmux >/dev/null || { echo "ABORT: tmux not installed (brew install tmux)"; exit 1; }
  # detached equivalent of kct: sources .zshrc so kc/dc resolve, KUSHBOT_AUTO_ATTACH=0 binds slot0
  tmux new-session -d -s kc -c "$HOME" "zsh -ic 'kc; exec zsh'"
  echo "Launched kc parent in detached tmux 'kc'. slot0 binds at boot."
  echo "Attach: tmux attach -t kc   ·   or just DM @example_laptop_bot"
}

restart() {
  echo "WARNING: recycling kc parent WIPES the always-on session's in-flight memory."
  if parent_running; then tmux kill-session -t kc; echo "killed old kc session"; sleep 2; fi
  up
}

case "$CMD" in
  status) status;;
  up) up;;
  restart) restart;;
  *) echo "usage: $0 {status|up|restart}"; exit 1;;
esac
