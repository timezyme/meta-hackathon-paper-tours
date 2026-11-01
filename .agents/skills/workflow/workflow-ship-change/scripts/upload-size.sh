#!/usr/bin/env bash
# Measure an upload before it happens: total bytes and file count of the given files or folders.
# Exits 3 when the whole upload is over the limit (default 50 MB), so the caller stops and asks the user.
#   upload-size.sh [--limit-mb 50] <path> [path ...]      e.g. upload-size.sh dist
set -uo pipefail
LIMIT_MB=50; [ "${1:-}" = "--limit-mb" ] && { LIMIT_MB="$2"; shift 2; }
[ $# -gt 0 ] || { echo "usage: upload-size.sh [--limit-mb N] <path>..."; exit 1; }
for path in "$@"; do
  [ -e "$path" ] || { echo "cannot measure missing path: $path" >&2; exit 1; }
done
files=$(find "$@" -type f | wc -l | tr -d ' ') || exit 1
if [ "$files" = 0 ]; then
  bytes=0
elif bytes=$(find "$@" -type f -print0 | xargs -0 stat -f '%z' 2>/dev/null | awk '{s+=$1} END{print s+0}'); then
  :
elif bytes=$(find "$@" -type f -print0 | xargs -0 stat -c '%s' 2>/dev/null | awk '{s+=$1} END{print s+0}'); then
  :
else
  echo "cannot measure upload: both BSD and GNU stat failed" >&2
  exit 1
fi
echo "upload: $files files, $(awk -v b="$bytes" 'BEGIN{printf "%.2f MiB", b/1048576}') ($bytes bytes); on disk $(du -sh "$@" 2>/dev/null | awk '{print $1}' | paste -sd+ -)"
if awk -v b="$bytes" -v l="$LIMIT_MB" 'BEGIN{exit !(b > l*1000*1000)}'; then
  echo "OVER ${LIMIT_MB} MB: ask the user first, stating this size. A host that skips unchanged files may send less; measure what it will actually send if you can, and never split the upload to get under."
  exit 3
fi
