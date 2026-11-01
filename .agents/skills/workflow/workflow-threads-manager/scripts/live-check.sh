#!/usr/bin/env bash
# HTTP smoke check: the page, up to 8 root-relative HTML references, and extra paths.
# Does not cover dynamically loaded assets or browser interactions.
# A page that returns 200 while its art returns 404 is a broken deploy (for example one shipped without its edge function).
#   live-check.sh <url> [extra-path ...]      (or set LIVE_URL)
set -uo pipefail
URL="${1:-${LIVE_URL:-}}"; [ -n "$URL" ] || { echo "usage: live-check.sh <url> [extra-path ...]"; exit 1; }; shift || true
URL="${URL%/}"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
code=$(curl -sS --connect-timeout 10 --max-time 30 -o "$tmp" -w '%{http_code}' "$URL/")
echo "page  $URL/  $code  $(wc -c < "$tmp" | tr -d ' ') B"
paths=$(grep -oE '(src|href)="/[^"]+"' "$tmp" | sed -E 's/^(src|href)="//; s/"$//' | grep -vE '^//' | sort -u | head -8)
bad=0; [ "${code:0:1}" = 2 ] || bad=1
for p in $paths "$@"; do
  c=$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "$URL$p")
  if [ "${c:0:1}" = 3 ]; then
    # A redirect is fine (e.g. art served from a storage bucket) if where it lands loads.
    f=$(curl -sS --connect-timeout 10 --max-time 30 -L -o /dev/null -w '%{http_code} %{size_download}B %{content_type}' "$URL$p")
    echo "      $p  $c → $f"
    case "$f" in 2*) ;; *) bad=$((bad+1)) ;; esac
  else
    echo "      $p  $c $(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{size_download}B %{content_type}' "$URL$p")"
    case "$c" in 2*) ;; *) bad=$((bad+1)) ;; esac
  fi
done
rm -f "$tmp"
[ "$bad" = 0 ] && echo "OK: page and every checked file load" || { echo "BROKEN: $bad check(s) failed (page or referenced files)"; exit 1; }
