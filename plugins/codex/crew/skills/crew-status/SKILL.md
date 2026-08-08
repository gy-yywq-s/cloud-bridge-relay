---
name: crew-status
description: Show the crew team roster and unread counts. Use when the human asks who is on the team or the team state.
---
Call `show_roster(code)` (find the team via `list_boxes` if no id given) and
relay the returned `say_to_owner` VERBATIM — do not reformat or summarize.
Then stop; a status check never acts on anyone's mail.
