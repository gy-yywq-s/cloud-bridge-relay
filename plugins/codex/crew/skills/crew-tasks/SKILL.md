---
name: crew-tasks
description: Show or work the crew team task board — add, claim, progress, close tasks. Use when the human mentions the crew board or tasks, or when picking up team work.
---
- SHOW: call `task_list(team)` and relay `say_to_owner` verbatim.
- ADD: `task_add(team, title, detail, deps?, assign_to?, priority?)` — one
  self-contained deliverable per task. Workers may not assign to others.
- WORK: claim from READY only (`task_claim`); leave a `task_progress` note at
  least hourly; close with `task_done(result=...)` the moment it is finished;
  then SELF-CLAIM the next ready task instead of going idle.
- Handoff mail auto-creates tasks; result mail naming "task #N" auto-closes.
- Human live views: https://board.gaelis.cc with the team view key
  (`board_key(team)`), or the terminal script at
  https://crew.gaelis.cc/client/board.
