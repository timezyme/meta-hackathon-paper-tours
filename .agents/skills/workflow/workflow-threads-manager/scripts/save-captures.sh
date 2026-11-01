#!/usr/bin/env bash
# Before archiving a thread: confirm its worktree has nothing unsaved or unmerged, then copy its gitignored screenshots
# out, because archiving a session deletes its worktree, ignored files included.
#   save-captures.sh <worktree-path> <name> [main-checkout]
# Copies <worktree>/qa/captures/ to <main-checkout>/qa/captures/archived-threads/<name>/ (gitignored there too).
# Exits 2 without copying if the worktree has uncommitted or untracked files or commits not on origin/main.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: save-captures.sh <worktree> <name> [main-checkout]"; exit 1; }
case "$2" in ""|.|..|*/*) echo "name must be one directory name"; exit 1 ;; esac
WT="$1"; NAME="$2"; MAIN="${3:-$(git -C "$WT" worktree list --porcelain | sed -n 's/^worktree //p' | head -1)}"
[ -d "$WT" ] || { echo "no worktree at $WT"; exit 1; }
git -C "$WT" fetch -q origin || { echo "NOT SAFE TO ARCHIVE: cannot refresh origin"; exit 2; }
dirty=$(git -C "$WT" status --porcelain --untracked-files=all | wc -l | tr -d ' ')
ahead=$(git -C "$WT" rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
echo "$(basename "$WT") [$(git -C "$WT" rev-parse --abbrev-ref HEAD)] uncommitted=$dirty unmerged=$ahead"
if [ "$dirty" != 0 ] || [ "$ahead" != 0 ]; then echo "NOT SAFE TO ARCHIVE: unsaved or unmerged work"; exit 2; fi
if [ -d "$WT/qa/captures" ]; then
  mkdir -p "$MAIN/qa/captures/archived-threads/$NAME"
  rsync -a "$WT/qa/captures/" "$MAIN/qa/captures/archived-threads/$NAME/"
  echo "saved $(du -sh "$MAIN/qa/captures/archived-threads/$NAME" | cut -f1) to qa/captures/archived-threads/$NAME/"
else
  echo "no qa/captures to save"
fi
echo "CAPTURES PRESERVED: inspect other ignored files and session state before archiving"
