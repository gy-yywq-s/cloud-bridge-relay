#!/usr/bin/env bash
# crew Stop-hook watcher.
#
# Runs when a turn ends. If crew has unread mail for this box it prints the
# mail and exits 2, which blocks the stop and continues the conversation with
# that mail in context — so the session never goes idle holding unread work.
#
# Inert until configured: with CREW_TOKEN or CREW_BOX unset it exits 0
# immediately, so installing the plugin changes nothing until you opt in.
#
#   export CREW_TOKEN=...              # a bearer the relay accepts (see below)
#   export CREW_BOX=bx-...             # printed when you onboard
#   export CREW_URL=https://crew.gaelisus.com  # optional, this is the default
#
# The token is only for calls made OUTSIDE a session (this hook). On a private
# self-hosted relay set one in CREW_STATIC_TOKENS; on the hosted instance ask the
# operator. Inside a session the MCP connection authenticates by OAuth instead.
#
# Loop guard: if the same batch is served twice running (because the session
# could not ack it), the hook stands down so the conversation can end.
set -uo pipefail

: "${CREW_TOKEN:=}" "${CREW_BOX:=}"
[ -z "$CREW_TOKEN" ] && exit 0
[ -z "$CREW_BOX" ] && exit 0
CREW_URL="${CREW_URL:-https://crew.gaelisus.com}"
STATE="${TMPDIR:-/tmp}/crew-watch-$CREW_BOX.last"

# The TypeScript relay serves the REST mirror under /api; the older Python relay
# served it at the root. Try /api first, fall back so both hosts keep working.
fetch() { curl -s -A crew-watch -H "Authorization: Bearer $CREW_TOKEN" --max-time 20 "$1" 2>/dev/null; }
MAIL=$(fetch "$CREW_URL/api/checkmail?box=$CREW_BOX&wait=0")
case "$MAIL" in
  ""|*unauthorized*|*"Cannot GET"*|*"not found"*) MAIL=$(fetch "$CREW_URL/checkmail?box=$CREW_BOX&wait=0") ;;
esac
[ -z "$MAIL" ] && exit 0

MAXID=$(printf '%s' "$MAIL" | python3 -c '
import json,sys
try:
    ms = json.load(sys.stdin).get("messages", [])
except Exception:
    ms = []
print(max((m["id"] for m in ms), default=0))
' 2>/dev/null) || exit 0
[ "${MAXID:-0}" = "0" ] && exit 0

LAST=$(cat "$STATE" 2>/dev/null || echo 0)
if [ "$MAXID" = "$LAST" ]; then
  # Already delivered this batch once and it was not acked — do not trap the
  # session in a loop; let it stop and surface the problem next turn.
  exit 0
fi
printf '%s' "$MAXID" > "$STATE"

printf '%s' "$MAIL" | CREW_BOX="$CREW_BOX" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
ms = d.get("messages", [])
print("crew: %d message(s) arrived while you were finishing." % len(ms))
for m in ms:
    f = m.get("from", {})
    print()
    print("[crew #%s %s] from %s (%s, %s%s)" % (
        m["id"], m.get("delivered_as", "").upper(), f.get("display_name"),
        f.get("box"), f.get("platform"),
        ", " + f["role"] if f.get("role") else ""))
    print(m.get("directive", ""))
    print(m.get("body", ""))
info = "Handle this now. ACTION means act and reply; CC is read-only."
print()
print(info, "Then call ack_mail(box=%r, through_id=%d)."
      % (os.environ["CREW_BOX"], max(m["id"] for m in ms)))
' >&2

exit 2
