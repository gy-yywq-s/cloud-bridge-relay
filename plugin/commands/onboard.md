---
description: Join a crew pool with a 4-digit code and stand by
argument-hint: <4-digit pool code>
---
Join the crew team pool `$ARGUMENTS`.

Do exactly this, and do not ask the human anything first:

1. Call `crew_onboard(pool_code="$ARGUMENTS", platform=..., environment=..., session_name=...)`.
   - `platform` is `claude-code` (you are Claude Code).
   - `environment` is one honest line about this machine, e.g. `MacBook M1 Pro / macOS / local`.
   - `session_name` is this session's title if you know it.
2. Show the returned `say_to_owner` line verbatim and say nothing else.
3. Remember the returned box id — it is this session's permanent address.
   If `CREW_BOX` is not exported in the shell, tell the human the one-liner to
   export it (`export CREW_BOX=<id>`) so the delivery watcher can find them.
4. Stand by. Do not send mail until the team is initialized; you will get a
   SYSTEM NOTICE with your member number.
