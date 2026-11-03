#!/usr/bin/env bash
#
# claude-data-backup.sh — weekly auto-commit of the owner's agent working data.
# Backs up BOTH agent homes so a disk death never loses working context:
#   ~/.claude → github.com/example-owner/claude-data  (transcripts/plans/tasks/agents/skills/config)
#   ~/.codex  → github.com/example-owner/codex-data   (codex sessions/history/skills/state DBs)
# Driven by com.kush.claude-data-backup LaunchAgent (every 7 days). Safe to run manually any time.
#
# Secrets are excluded by each repo's .gitignore (auth.json / *.env / *.token / *.key / ...).
# GUARD: any single file >95MB is unstaged before commit — GitHub hard-fails at 100MB/file and
# we're not using LFS (the owner's call). 95MB is a CEILING, not a tunable: raising it past 100MB
# converts a clean skip into a push failure that blocks every other file in the commit.
# FAILSAFE (2026-08-01): the oversized file is no longer merely skipped. It's handed to
# claude-data-chunk.sh, which splits it into gzipped line-aligned parts under large-files/ and
# commits those instead; claude-data-restore.sh rebuilds it with sha256 verification.
# Chunking is meant to stay RARE — at 2026-08-01, 1 of 19,373 tracked files trips it. If the log
# starts showing several, the problem is session hygiene (one session grown to 40k+ turns), not
# the threshold. Check with: claude-data-restore.sh --list
# ADDITIVE: `git add --ignore-removal` adds new+modified files but does NOT stage deletions, so
# local pruning (claude cleanupPeriodDays, codex log rotation) never propagates to the backup —
# the GitHub copy accumulates history. To switch a repo to mirror mode: use `git add -A`.
#
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
LOG="$HOME/kush/logs/claude-data-backup.log"
MAXBYTES=99614720   # 95 MiB — ceiling set by GitHub's 100MB/blob hard reject. Do not raise.
CHUNKER="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/claude-data-chunk.sh"
mkdir -p "$(dirname "$LOG")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# backup_repo <dir> <label> — additive commit + push of one agent-data git repo.
backup_repo() {
  local dir="$1" label="$2" f sz skipped="" out n branch
  local -a oversized=()   # array, not a string — paths must never be re-split on whitespace
  cd "$dir" 2>/dev/null || { echo "$(ts) [$label] ERROR: no $dir" >>"$LOG"; return 1; }
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "$(ts) [$label] ERROR: $dir not a git repo" >>"$LOG"; return 1; }

  # additive stage (new + modified, not deletions)
  git add --ignore-removal . 2>>"$LOG"

  # unstage anything too big for GitHub (no LFS), then chunk it so it IS still backed up
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    if [ "$sz" -gt "$MAXBYTES" ]; then
      git reset -q HEAD -- "$f" 2>>"$LOG"
      oversized+=("$f")
      skipped="$skipped\n  $f ($((sz/1048576))MB)"
    fi
  done < <(git diff --cached --name-only)

  if [ -n "$skipped" ]; then
    echo -e "$(ts) [$label] >95MB, too big to commit directly:$skipped" >>"$LOG"
    for f in "${oversized[@]}"; do
      if [ -x "$CHUNKER" ]; then
        if out=$("$CHUNKER" "$dir" "$f" 2>&1); then
          echo "$(ts) [$label]   ✓ $out" >>"$LOG"
        else
          echo "$(ts) [$label]   ⚠ CHUNK FAILED — $f HAS NO BACKUP: $out" >>"$LOG"
        fi
      else
        echo "$(ts) [$label]   ⚠ no chunker at $CHUNKER — $f HAS NO BACKUP" >>"$LOG"
      fi
    done
    # pick up the parts the chunker just wrote (dir won't exist if every chunk failed)
    [ -d "$dir/large-files" ] && git add --ignore-removal large-files 2>>"$LOG"
  fi

  if git diff --cached --quiet; then
    echo "$(ts) [$label] no changes" >>"$LOG"
    return 0
  fi

  n=$(git diff --cached --name-only | wc -l | tr -d ' ')
  branch=$(git branch --show-current 2>/dev/null); branch="${branch:-main}"
  if git commit -q -m "auto: weekly $label backup ($(date '+%Y-%m-%d'))" 2>>"$LOG"; then
    if git push -q origin "$branch" 2>>"$LOG"; then
      echo "$(ts) [$label] ✓ committed + pushed $n files" >>"$LOG"
    else
      echo "$(ts) [$label] ⚠ committed $n files but PUSH FAILED (check auth / large files)" >>"$LOG"
    fi
  else
    echo "$(ts) [$label] ERROR: commit failed" >>"$LOG"
  fi
}

# Sourcing this file defines backup_repo without running a backup — lets the chunk/guard path
# be exercised against a throwaway repo instead of the live ones.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  echo "$(ts) ===== backup run start =====" >>"$LOG"
  backup_repo "$HOME/.claude" "claude-data"
  backup_repo "$HOME/.codex"  "codex-data"
  echo "$(ts) ===== backup run end =====" >>"$LOG"
fi
