#!/usr/bin/env bash
#
# claude-data-chunk.sh — FAILSAFE for files GitHub will not accept (>100MB/blob, no LFS).
#
# Called by claude-data-backup.sh when a file trips the 95MB guard. Instead of silently
# skipping the file (the old behaviour, which left a 167MB session with zero off-disk
# copies for weeks), we split it into gzipped parts small enough to commit.
#
# WHY LINE-ALIGNED BYTE CHUNKS:
#   Claude transcripts are JSONL and strictly APPEND-ONLY. Chunk boundaries are chosen
#   greedily from the start of the file, so a given prefix always produces byte-identical
#   parts. Every part except the tail is therefore SEALED — git stores it exactly once and
#   never sees it again. Only the growing tail part churns between runs (~<20MB).
#   Naively gzipping the whole file instead would hand git a fresh ~84MB blob every single
#   run, since git cannot delta-compress gzip output.
#
#   gzip -n is mandatory: it omits the mtime/filename header so identical input yields
#   byte-identical output. Without it every part would look "modified" on every run and
#   the sealing property collapses.
#
# LAYOUT (mirrors the original path so restore is unambiguous):
#   ~/.claude/large-files/<original-relative-path>/
#       manifest.json          <- original size, sha256, line count, part list + per-part sha256
#       part-0000.gz  (sealed)
#       part-0001.gz  (sealed)
#       ...
#       part-00NN.gz  (tail, rewritten until it fills)
#
# Restore with: claude-data-restore.sh
#
# Usage: claude-data-chunk.sh <repo-root> <path-relative-to-repo-root>
#
set -uo pipefail
export LC_ALL=C          # length() must count BYTES, not multibyte chars

CHUNK_BYTES=${CHUNK_BYTES:-20971520}   # 20 MiB raw per part; ~8-10MB gzipped

# Portability: this runs on the Mac (BSD stat, shasum) AND on server (GNU stat,
# sha256sum). Resolve both up front rather than sprinkling `|| true` fallbacks.
if stat -f%z . >/dev/null 2>&1; then fsize() { stat -f%z "$1"; }   # BSD / macOS
else                                 fsize() { stat -c%s "$1"; }   # GNU / Linux
fi
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | awk '{print $1}'; }
else                                          sha() { shasum -a 256 "$1" | awk '{print $1}'; }
fi

ROOT="${1:?usage: claude-data-chunk.sh <repo-root> <relpath>}"
REL="${2:?usage: claude-data-chunk.sh <repo-root> <relpath>}"
SRC="$ROOT/$REL"
OUT="$ROOT/large-files/$REL"

[ -f "$SRC" ] || { echo "chunk: no such file: $SRC" >&2; exit 1; }

SRC_SIZE=$(fsize "$SRC")
SRC_SHA=$(sha "$SRC")

# Nothing changed since last run? Skip the work entirely.
if [ -f "$OUT/manifest.json" ]; then
  PREV_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source"]["sha256"])' "$OUT/manifest.json" 2>/dev/null || echo "")
  if [ "$PREV_SHA" = "$SRC_SHA" ]; then
    echo "chunk: unchanged, skipping: $REL"
    exit 0
  fi
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/cdchunk.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

# Greedy line-aligned split. A line is never broken across parts, so each part is
# independently valid JSONL and `cat`ing them back is exact.
awk -v maxb="$CHUNK_BYTES" -v pre="$TMP/part-" '
BEGIN { n = 0; cur = 0; out = sprintf("%s%04d", pre, n) }
{
  len = length($0) + 1
  if (cur > 0 && cur + len > maxb) { close(out); n++; cur = 0; out = sprintf("%s%04d", pre, n) }
  print >> out
  cur += len
}
END { close(out) }
' "$SRC"

mkdir -p "$OUT"

NEW=0; RESEALED=0; TOTAL=0
PARTS_JSON=""
for p in "$TMP"/part-*; do
  [ -f "$p" ] || continue
  base=$(basename "$p")
  TOTAL=$((TOTAL + 1))
  lines=$(wc -l < "$p" | tr -d ' ')
  raw=$(fsize "$p")
  rawsha=$(sha "$p")

  gzip -9 -n -c "$p" > "$TMP/$base.gz"
  dest="$OUT/$base.gz"

  if [ -f "$dest" ] && cmp -s "$TMP/$base.gz" "$dest"; then
    :                                   # sealed and identical — git sees nothing
  else
    [ -f "$dest" ] && RESEALED=$((RESEALED + 1)) || NEW=$((NEW + 1))
    mv "$TMP/$base.gz" "$dest"
  fi

  gz=$(fsize "$dest")
  [ -n "$PARTS_JSON" ] && PARTS_JSON="$PARTS_JSON,"
  PARTS_JSON="$PARTS_JSON{\"name\":\"$base.gz\",\"lines\":$lines,\"raw_bytes\":$raw,\"gz_bytes\":$gz,\"raw_sha256\":\"$rawsha\"}"
done

# Drop stale parts from a previous, longer run (defensive — append-only input shouldn't shrink)
for dest in "$OUT"/part-*.gz; do
  [ -f "$dest" ] || continue
  b=$(basename "$dest" .gz)
  [ -f "$TMP/$b" ] || { rm -f "$dest"; echo "chunk: removed stale part $b"; }
done

SRC_LINES=$(wc -l < "$SRC" | tr -d ' ')
GZ_TOTAL=$(for g in "$OUT"/part-*.gz; do [ -f "$g" ] && fsize "$g"; done | awk '{s+=$1} END {print s+0}')

cat > "$OUT/manifest.json" <<EOF
{
  "format": "claude-data-chunk/1",
  "source": {
    "path": "$REL",
    "bytes": $SRC_SIZE,
    "lines": $SRC_LINES,
    "sha256": "$SRC_SHA"
  },
  "chunking": {
    "strategy": "line-aligned-greedy-bytes",
    "chunk_bytes": $CHUNK_BYTES,
    "parts": $TOTAL,
    "gz_total_bytes": $GZ_TOTAL
  },
  "restore": "cat part-*.gz | gunzip > <path>   (or: claude-data-restore.sh)",
  "parts": [$PARTS_JSON]
}
EOF

echo "chunk: $REL -> $TOTAL parts ($((SRC_SIZE/1048576))MB raw -> $((GZ_TOTAL/1048576))MB gz), $NEW new, $RESEALED rewritten, $((TOTAL-NEW-RESEALED)) sealed-unchanged"
