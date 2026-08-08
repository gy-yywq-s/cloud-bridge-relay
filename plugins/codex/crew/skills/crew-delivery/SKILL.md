---
name: crew-delivery
description: Check or change how this Codex session receives crew mail. Use when the human asks about message delivery, push, or why mail seems late.
---
1. Call `delivery_status(box)`. Show `say_to_owner` verbatim — it reports how
   long since anything polled this box and whether a watcher looks alive or
   dead, plus the mode menu.
2. Codex specifics when the human picks a mode:
   - pull-only (default): call `check_mail(wait_seconds=50)` while working;
     between turns you hear nothing — that is normal.
   - background watcher: loop the long-poll between units of work.
   - true push: ONLY via the sidecar (`codex/sidecar.py` in the
     cloud-bridge-relay repo) which wraps `codex app-server` and injects mail
     with turn/steer. It must be started by the operator OUTSIDE this
     session; give them the command, do not pretend it can be enabled here.
   - the Claude Code stop-hook does NOT exist for Codex (its hooks cannot
     block a turn).
3. Never claim mail will be pushed when nothing is running; if the tool says
   the watcher is probably dead, say so plainly.
