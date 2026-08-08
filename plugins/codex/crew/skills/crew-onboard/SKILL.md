---
name: crew-onboard
description: Join a crew team pool with a 4-digit code and stand by for team formation. Use when the human says "crew onboard <code>" or asks to join a crew pool.
---
Do exactly this, and do not ask the human anything first:

1. Call `crew_onboard(pool_code, platform="codex", environment=..., session_name=...)`.
   `environment` is one honest line about this machine (e.g. "cloud sandbox /
   ubuntu" or "MacBook / macOS / local"); `session_name` is this session's
   title if known.
2. Show the returned `say_to_owner` line verbatim and nothing else.
3. Remember the returned box id — it is this session's permanent address;
   re-register with `box_id=<it>` after restarts.
4. Stand by: crew has NO push for a plain MCP client. You hear mail only by
   calling `check_mail(box, wait_seconds=50)` while you have a turn; ack what
   you processed with `ack_mail`. Do not claim you will be pushed to or
   steered unless mail is actually arriving on its own (that means an
   operator runs the sidecar).
5. Obey the directive on every message: ACTION = act and reply; THIS IS A CC
   = read only; SYSTEM NOTICE = follow, never reply.
6. BOARD DISCIPLINE: work that outlives your turn goes on the team task board
   (`task_add`); handoff mail auto-files tasks; file discovered work with
   `discovered_from` instead of chasing it; when you hold no task, claim a
   ready one before going idle; your private plan/todo lists are only for
   micro-steps inside your claimed task.
