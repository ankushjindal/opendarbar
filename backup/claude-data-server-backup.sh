#!/usr/bin/env bash
#
# claude-data-server-backup.sh — weekly backup of ALL server claude sessions
# (parent kai + every ~/*-home bot) into the private repo example-owner/claude-data-server.
#
# Aggregates each <home>/.claude/projects into the repo under a per-bot subdir,
# excludes secrets + raw media, guards files >95MB (GitHub hard-fails at 100MB,
# no LFS), commits + pushes. Mirror of the Mac claude-data weekly job.
#
# >95MB files are NOT dropped (2026-08-01): they go to claude-data-chunk.sh, which
# commits them as gzipped line-aligned parts under large-files/. Rebuild with
# claude-data-restore.sh. Same failsafe as the Mac job — ported after a 167MB Mac
# session was found with zero off-disk copies because the old guard skipped silently.
#
# Install: put this at ~/kai/claude-data-server-backup.sh, chmod +x, then add a
# weekly cron (see ~/taildrop-inbox handoff doc).
#
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$HOME/claude-data-server"
LOG="$HOME/kai/logs/claude-data-server-backup.log"
MAXBYTES=99614720   # 95 MiB — ceiling set by GitHub's 100MB/blob hard reject. Do not raise.
CHUNKER="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/claude-data-chunk.sh"
mkdir -p "$(dirname "$LOG")" "$REPO"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

cd "$REPO" || { echo "$(ts) ERROR: no $REPO" >>"$LOG"; exit 1; }
if [ ! -d .git ]; then
  git init -q
  git remote add origin https://github.com/example-owner/claude-data-server.git
  git branch -M main
fi

# secret/media-excluding gitignore (defense in depth; rsync also excludes)
cat > .gitignore <<'EOF'
*.env
.env
.env.*
*.token
*.pem
*.key
*.credentials.json
*.pid
*.sock
inbox/
image-cache/
cache/
shell-snapshots/
*.log
EOF

# NOTE (2026-06-24, the owner): rsync runs ADDITIVE (no --delete). Reason: this lets us
# prune local ~/<son>-home/.claude/projects/*.jsonl files to free server disk without
# the deletions propagating to the GitHub backup on the next cron. Net effect: backup
# repo accumulates history (~1 GB/year ceiling, well under GitHub's 100 GB soft limit).
# To switch back to mirror behavior, add `--delete` to each rsync invocation below.
EXCL=(--exclude='*.env' --exclude='*.token' --exclude='*.key' --exclude='*.pem'
      --exclude='*.pid' --exclude='*.credentials.json' --exclude='inbox/'
      --exclude='image-cache/' --exclude='cache/' --exclude='shell-snapshots/')

# parent kai
[ -d "$HOME/.claude/projects" ] && { mkdir -p "$REPO/parent/projects"; rsync -a "${EXCL[@]}" "$HOME/.claude/projects/" "$REPO/parent/projects/"; }
# also back up parent config worth keeping (no secrets)
for f in CLAUDE.md; do [ -f "$HOME/.claude/$f" ] && cp "$HOME/.claude/$f" "$REPO/parent/$f"; done
[ -d "$HOME/.claude/agents" ] && { mkdir -p "$REPO/parent/agents"; rsync -a "${EXCL[@]}" "$HOME/.claude/agents/" "$REPO/parent/agents/"; }

# every bot home
for h in "$HOME"/*-home; do
  [ -d "$h/.claude/projects" ] || continue
  name="$(basename "$h")"
  mkdir -p "$REPO/$name/projects"
  rsync -a "${EXCL[@]}" "$h/.claude/projects/" "$REPO/$name/projects/"
done

git add -A
# unstage anything >95MB (no LFS), then chunk it so it IS still backed up
skipped=""
oversized=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$sz" -gt "$MAXBYTES" ]; then
    git reset -q HEAD -- "$f"
    oversized+=("$f")
    skipped="$skipped $f ($((sz/1048576))MB)"
  fi
done < <(git diff --cached --name-only)

if [ -n "$skipped" ]; then
  echo "$(ts) >95MB, too big to commit directly:$skipped" >>"$LOG"
  for f in "${oversized[@]}"; do
    if [ -x "$CHUNKER" ]; then
      if out=$("$CHUNKER" "$REPO" "$f" 2>&1); then echo "$(ts)   ✓ $out" >>"$LOG"
      else echo "$(ts)   ⚠ CHUNK FAILED — $f HAS NO BACKUP: $out" >>"$LOG"; fi
    else
      echo "$(ts)   ⚠ no chunker at $CHUNKER — $f HAS NO BACKUP" >>"$LOG"
    fi
  done
  [ -d "$REPO/large-files" ] && git add -A large-files 2>>"$LOG"
fi

if git diff --cached --quiet; then echo "$(ts) no changes" >>"$LOG"; exit 0; fi
n=$(git diff --cached --name-only | wc -l | tr -d ' ')
if git commit -q -m "auto: weekly server claude backup ($(date '+%Y-%m-%d'))"; then
  if git push -q origin main; then echo "$(ts) ✓ pushed $n files" >>"$LOG"
  else echo "$(ts) ⚠ committed $n but PUSH FAILED (check gh auth / large files)" >>"$LOG"; fi
else echo "$(ts) ERROR commit failed" >>"$LOG"; fi
