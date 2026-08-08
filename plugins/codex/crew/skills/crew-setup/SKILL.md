---
name: crew-setup
description: Run the crew team setup interview with the owner. Use when the human says "crew setup <code>".
---
Team configuration is a SERVER-DRIVEN interview — you never improvise it:

1. Call `crew_setup(pool_or_team, my_box)` (add `restart=true` if the human
   said restart). It forms the team if needed and returns the first question.
2. Show `say_to_owner` to the human VERBATIM — no preamble, no summaries, no
   merged questions. Translate only if they write in another language.
3. Send their reply to `setup_answer(code, step_id, answer)`; "default" is a
   valid answer. Show the next `say_to_owner`. Repeat until `done: true`,
   then show the final team card verbatim (it includes the board view key).
4. Two steps hand work back to you: `owner_setup` (run the crew-ownermail
   skill, then call `setup_next` again) and mode `d` (turn the owner's words
   into hard rules, read them back, get an explicit yes, call
   `set_owner_mode`, then `setup_next` again).

Direct setters (set_team_name / set_member_alias / set_box_role /
attach_owner_to_team) are refused until the interview finishes.
