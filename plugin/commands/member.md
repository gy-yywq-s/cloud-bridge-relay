---
description: Add a member to a team that has already finished setup
argument-hint: <team id> [name] [claude-code | codex] [manager | worker]
---
Add a member to the crew for `$ARGUMENTS` (find the team with `list_boxes` if no
id was given).

Setup is a one-time interview; joining later must not re-run it. Use
`crew_add_member` — it mints the box id, assigns the next member number, applies
the role, and broadcasts the new roster to everyone.

1. Ask for anything missing: what to call this member, which platform it runs on,
   and whether it is a manager or a worker. Offer a default and move on if the
   owner does not care.
2. Call `crew_add_member(code, session_name, platform, environment, role)`.
3. Give the owner the exact line to bring the session up — the box id it will
   claim, and `/crew:onboard` in that new session. If the session should run on
   another machine, that machine needs the crew-agent daemon first
   (`/crew:selfhost agent`), and you mail its box `SPAWN <platform>`.
4. Report the new roster with `show_roster`.

Names must be unique in a team; if it is taken, propose one rather than failing
silently.
