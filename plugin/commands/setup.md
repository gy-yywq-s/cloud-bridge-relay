---
description: Run the guided team setup interview with the owner
argument-hint: <pool code or team id> [restart]
---
Set up the crew team for `$ARGUMENTS`.

This is a server-driven interview. You do not design the questions and you do
not decide anything on the owner's behalf.

1. Call `crew_setup(pool_or_team=..., my_box=...)` (add `restart=true` if the
   human included the word restart). It forms the team if needed and returns
   the first question.
2. Show `say_to_owner` to the human VERBATIM — no preamble, no summary, no
   merging of questions. Translate only if they write in another language.
3. Send their reply straight to `setup_answer(code, step_id, answer)`.
   `default` is a valid answer. Show the next `say_to_owner`. Repeat.
4. When `done: true`, show the final `say_to_owner` (the team card).

Two steps hand work back to you: `owner_setup` (run `/crew:ownermail` first,
then call `setup_next` again) and mode `d` (turn the owner's wording into hard
rules, read them back, get an explicit yes, call `set_owner_mode`, then
`setup_next` again).
