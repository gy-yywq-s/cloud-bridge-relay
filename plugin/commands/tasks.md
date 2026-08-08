---
description: Show the team task board; add, claim, or close tasks
argument-hint: [team id]
---
Work the crew task board for `$ARGUMENTS` (find the team via `list_boxes` if
no id given).

- To SHOW it: call `task_list(team)` and relay `say_to_owner` verbatim.
- To ADD work the human names: `task_add(team, title, detail, deps?,
  assign_to?, priority?)` — one self-contained deliverable per task.
- To WORK: claim from READY only (`task_claim`), leave a `task_progress` note
  at least hourly, close with `task_done(result=...)` the moment it is
  finished, then SELF-CLAIM the next ready task instead of going idle.
- Handoff mail auto-creates tasks; result mail naming "task #N" auto-closes.
- Live views for the human: terminal — `curl -s
  https://relay.gaelis.cc/client/board -o crew-board.sh && CREW_TOKEN=...
  CREW_TEAM=... bash crew-board.sh`; the same data is at `/tasks?team=` and
  `/board?team=` (needs a bearer credential today).
