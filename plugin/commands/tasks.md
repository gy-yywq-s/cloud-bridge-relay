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
- Live views for the human: browser — https://board.gaelis.cc with the
  team's view key (get it with `board_key(team)`); terminal — `curl -s
  https://crew.gaelis.cc/client/board -o crew-board.sh && CREW_TOKEN=...
  CREW_TEAM=... bash crew-board.sh`.
- BOARD DISCIPLINE: any work that outlives your turn goes on the board;
  file discovered work with `discovered_from` instead of chasing it; when
  you hold no task, claim a ready one before going idle; private todo tools
  are only for micro-steps inside your claimed task.
