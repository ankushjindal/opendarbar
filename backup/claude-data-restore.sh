#!/usr/bin/env bash
#
# claude-data-restore.sh — rebuild oversized transcripts that were chunked by
# claude-data-chunk.sh because GitHub rejects blobs over 100MB.
#
# These files exist in the backup ONLY as gzipped parts under large-files/. Restoring
# is verified: the reassembled file's sha256 must match the manifest, or nothing is
# written to the destination.
#
# Usage:
#   claude-data-restore.sh --list                       # what's available, sizes, integrity
#   claude-data-restore.sh --all [--dest DIR]           # restore everything
#   claude-data-restore.sh <relpath> [--dest DIR]       # restore one file
#   claude-data-restore.sh --all --force                # overwrite existing files
#
# --dest defaults to the repo root (~/.claude), i.e. files land back at their original
# paths. Use --dest to stage a restore somewhere safe first.
#
set -uo pipefail

ROOT="${CLAUDE_DATA_ROOT:-$HOME/.claude}"
LARGE="$ROOT/large-files"
DEST="$ROOT"
FORCE=0
MODE=""
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list)  MODE=list; shift ;;
    --all)   MODE=all; shift ;;
    --force) FORCE=1; shift ;;
    --dest)  DEST="${2:?--dest needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *)       MODE=one; TARGET="$1"; shift ;;
  esac
done

[ -d "$LARGE" ] || { echo "No chunked files: $LARGE does not exist."; exit 0; }
[ -n "$MODE" ] || { sed -n '2,20p' "$0"; exit 1; }

# Portable across the Mac (shasum) and server (sha256sum).
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | awk '{print $1}'; }
else                                          sha() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

mf_get() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval("d"+sys.argv[2]))' "$1" "$2"; }

manifests() { find "$LARGE" -name manifest.json | sort; }

if [ "$MODE" = list ]; then
  printf "%-72s %10s %6s %10s\n" "SOURCE PATH" "ORIG" "PARTS" "STORED"
  manifests | while IFS= read -r m; do
    p=$(mf_get "$m" '["source"]["path"]')
    b=$(mf_get "$m" '["source"]["bytes"]')
    n=$(mf_get "$m" '["chunking"]["parts"]')
    g=$(mf_get "$m" '["chunking"]["gz_total_bytes"]')
    have=$(find "$(dirname "$m")" -name 'part-*.gz' | wc -l | tr -d ' ')
    flag=""; [ "$have" != "$n" ] && flag="  !! MISSING PARTS: have $have of $n"
    printf "%-72s %9sM %6s %9sM%s\n" "$p" "$((b/1048576))" "$n" "$((g/1048576))" "$flag"
  done
  exit 0
fi

restore_one() {
  local m="$1" src_path bytes want n dir out tmp got
  dir=$(dirname "$m")
  src_path=$(mf_get "$m" '["source"]["path"]')
  bytes=$(mf_get "$m" '["source"]["bytes"]')
  want=$(mf_get "$m" '["source"]["sha256"]')
  n=$(mf_get "$m" '["chunking"]["parts"]')

  local have; have=$(find "$dir" -name 'part-*.gz' | wc -l | tr -d ' ')
  if [ "$have" != "$n" ]; then
    echo "SKIP $src_path — incomplete: have $have of $n parts"
    return 1
  fi

  out="$DEST/$src_path"
  if [ -e "$out" ] && [ "$FORCE" != 1 ]; then
    echo "SKIP $src_path — exists (use --force to overwrite)"
    return 1
  fi

  mkdir -p "$(dirname "$out")"
  tmp="$out.restoring.$$"
  # shellcheck disable=SC2012
  ls "$dir"/part-*.gz | sort | while IFS= read -r part; do gunzip -c "$part"; done > "$tmp"

  got=$(sha "$tmp")
  if [ "$got" != "$want" ]; then
    echo "FAIL $src_path — sha256 mismatch (expected $want, got $got); left at $tmp"
    return 1
  fi

  mv "$tmp" "$out"
  echo "OK   $src_path  ($((bytes/1048576))MB, $n parts, sha256 verified)"
}

rc=0
if [ "$MODE" = all ]; then
  while IFS= read -r m; do restore_one "$m" || rc=1; done < <(manifests)
else
  m="$LARGE/$TARGET/manifest.json"
  if [ ! -f "$m" ]; then
    m=$(manifests | while IFS= read -r x; do
          [ "$(mf_get "$x" '["source"]["path"]')" = "$TARGET" ] && echo "$x"; done | head -1)
  fi
  [ -f "${m:-}" ] || { echo "No manifest for: $TARGET  (try --list)"; exit 1; }
  restore_one "$m" || rc=1
fi
exit $rc
