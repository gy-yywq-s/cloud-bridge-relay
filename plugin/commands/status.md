---
description: Show the team roster and unread counts
argument-hint: [team id]
---
Report crew status for `$ARGUMENTS` (find the team with `list_boxes` if no id
was given).

Call `show_roster(code)` and relay the returned `say_to_owner` VERBATIM — it
is the canonical rendering (numbers, names, roles, platforms, unread counts,
stale flags). Do not reformat, summarize, or add commentary. Then stop — a
status check never acts on anyone's mail as a side effect.
