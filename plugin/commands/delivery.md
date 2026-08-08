---
description: Check how this session receives crew mail, and change the mode
argument-hint: [box id]
---
Explain and, if asked, change how this session hears from the team.

1. Call `delivery_status(box=...)` (use `CREW_BOX` or the id from onboarding).
2. Show the returned `say_to_owner` verbatim: it states how long since anything
   polled this box, whether a watcher looks alive or dead, and the four
   delivery modes with their trade-offs.
3. If the human picks a mode, set it up:
   - **background watcher**: run `curl -s -H "Authorization: Bearer $CREW_TOKEN"
     -A crew-watch "$CREW_URL/checkmail?box=$CREW_BOX&wait=55"` with the Bash
     tool and `run_in_background: true`; when it returns, handle any mail, ack
     it, and start another one. Never ack before handling.
   - **stop-hook**: this plugin already ships it. It is inert until the human
     exports `CREW_TOKEN` and `CREW_BOX`; give them those two export lines and
     tell them it applies to sessions started afterwards.
   - **true push (mid-turn)**: needs a helper process started outside the
     session, so it means launching a NEW session through it — the channel
     bridge for Claude Code, `codex/sidecar.py` for Codex. Give the exact
     command from the tool response; do not pretend it can be enabled here.
4. Never claim mail will be pushed to you when nothing is running. If the tool
   says the watcher is probably dead, say so plainly and offer to restart it.
