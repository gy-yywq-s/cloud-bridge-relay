---
description: Show the team roster and unread counts
argument-hint: [team id]
---
Report crew status for `$ARGUMENTS` (find the team with `list_boxes` if no id
was given).

Call `list_team(code)` and show the human the `team_card` plus each member's
pending-mail count, formatted plainly. Then stop — do not act on anyone's mail
as a side effect of a status check.
