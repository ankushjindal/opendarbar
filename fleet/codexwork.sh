#!/usr/bin/env bash
# codexwork <name> — drop into an INTERACTIVE codex session on a codex son's own
# thread, the way `batt` gives you an interactive Claude son. A codex thread can
# NOT serve an interactive TUI and its Telegram bridge at the same time (the
# headless app-server the bridge drives ≠ the interactive CLI), so this pauses
# the bridge for the duration and auto-restarts it on exit — the bridge
# thread/resumes the SAME thread, so your terminal work carries into Telegram.
#
# Invoked by the Mac `batt -w <name>` over `ssh -t` (needs a TTY for the codex TUI).
# Server-side companion to fleet/batt.zsh. Symlinked to ~/kai/codexwork.sh.
set -uo pipefail
export PATH="/home/owner/.local/bin:/home/owner/.bun/bin:$PATH"

name="${1:?usage: codexwork <name>}"
sup="$HOME/kai/codex-$name.sh"
tmuxs="codex-$name"
state="$HOME/.codex/$name/.thread-state-slot0.json"

[ -f "$sup" ] || { echo "✗ no codex supervisor for '$name' ($sup) — is it a codex son?"; exit 1; }
model=$(grep -oE 'MODEL="[^"]+"' "$sup" | head -1 | sed 's/^MODEL="//; s/"$//'); model="${model:-gpt-5.6-sol}"
cwd=$(grep -oE 'CWD="[^"]+"'   "$sup" | head -1 | sed 's/^CWD="//; s/"$//');   cwd="${cwd:-$HOME/monorepo}"
tid=$(python3 -c "import json;print(json.load(open('$state')).get('threadId',''))" 2>/dev/null || true)

restart_bridge() {
  echo
  echo "↻  restarting $name's Telegram bridge…"
  tmux kill-session -t "$tmuxs" 2>/dev/null || true   # in case a stray remains
  tmux new-session -d -s "$tmuxs" "bash $sup"
  sleep 3
  if tmux has-session -t "$tmuxs" 2>/dev/null; then
    echo "✅ $name bridge back up — @${name}_son_of_kai_bot is live on Telegram again."
  else
    echo "⚠ bridge restart FAILED. Run: tmux new-session -d -s $tmuxs \"bash $sup\""
  fi
}
trap restart_bridge EXIT   # runs even on codex crash / Ctrl-C — the bridge always comes back

echo "⏸  pausing $name's bridge — @${name}_son_of_kai_bot goes OFFLINE while you work here."
tmux kill-session -t "$tmuxs" 2>/dev/null || true
sleep 2

echo "▶  interactive codex · $name · $model · $cwd"
echo "   /exit or Ctrl-D when done → the bridge auto-restarts and Telegram resumes this same thread."
echo
if [ -n "$tid" ]; then
  codex resume "$tid" -m "$model" -C "$cwd" -c approval_policy=never -c sandbox_mode=danger-full-access
else
  echo "(no saved threadId for $name — starting a fresh interactive codex instead)"
  codex -m "$model" -C "$cwd" -c approval_policy=never -c sandbox_mode=danger-full-access
fi
# EXIT trap restarts the bridge
