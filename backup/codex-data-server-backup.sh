#!/usr/bin/env bash
#
# codex-data-server-backup.sh — weekly backup of server's codex working data
# (~/.codex: sessions, history, AGENTS.md personas, config) into the private
# repo example-owner/codex-data-server. Sibling of claude-data-server-backup.sh
# (same staging-clone pattern, same cron cadence, same 95MB guard).
#
# Secrets NEVER backed up: auth.json (OAuth), *.env/*.token/*.key. Auth is
# always re-earned on a new machine (`codex login`), never restored.
#
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$HOME/codex-data-server"
LOG="$HOME/kai/logs/codex-data-server-backup.log"
MAXBYTES=99614720   # 95 MiB — ceiling set by GitHub's 100MB/blob hard reject. Do not raise.
CHUNKER="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/claude-data-chunk.sh"
mkdir -p "$(dirname "$LOG")" "$REPO"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

cd "$REPO" || { echo "$(ts) ERROR: no $REPO" >>"$LOG"; exit 1; }
if [ ! -d .git ]; then
  git init -q
  git remote add origin https://github.com/example-owner/codex-data-server.git
  git branch -M main
fi

# secret/ephemeral-excluding gitignore (defense in depth; rsync also excludes)
cat > .gitignore <<'EOF'
auth.json
*.env
.env
.env.*
*.token
*.pem
*.key
*.pid
*.sock
cache/
log/
tmp/
.tmp/
models_cache.json
*.sqlite-shm
*.sqlite-wal
*.log
packages/
EOF

EXCL=(--exclude='auth.json' --exclude='*.env' --exclude='*.token' --exclude='*.key'
      --exclude='*.pem' --exclude='*.pid' --exclude='cache/' --exclude='log/'
      --exclude='tmp/' --exclude='.tmp/' --exclude='models_cache.json'
      --exclude='*.sqlite-shm' --exclude='*.sqlite-wal' --exclude='packages/')

# parent ~/.codex (sons don't run codex on server today; add loops like the
# claude script's ~/*-home glob if that ever changes)
[ -d "$HOME/.codex" ] && { mkdir -p "$REPO/parent"; rsync -a "${EXCL[@]}" "$HOME/.codex/" "$REPO/parent/"; }

# additive stage (new + modified, not deletions) — mirrors the claude scripts
git add --ignore-removal . 2>>"$LOG"

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
  [ -d "$REPO/large-files" ] && git add --ignore-removal large-files 2>>"$LOG"
fi

if git diff --cached --quiet; then echo "$(ts) no changes" >>"$LOG"; exit 0; fi
n=$(git diff --cached --name-only | wc -l | tr -d ' ')
if git commit -q -m "auto: weekly server codex backup ($(date '+%Y-%m-%d'))"; then
  if git push -q origin main; then echo "$(ts) ✓ pushed $n files" >>"$LOG"
  else echo "$(ts) ⚠ committed $n but PUSH FAILED (check gh auth / large files)" >>"$LOG"; fi
else echo "$(ts) ERROR commit failed" >>"$LOG"; fi
