---
name: crew-member
description: Add a member to a crew team that already finished setup. Use when someone new should join an existing team without re-running the interview.
---
Setup is a one-time interview — never re-run it to add someone. Use
`crew_add_member(code, session_name, platform, environment, role)`: it mints the
box id, assigns the next member number, applies the role, and broadcasts the new
roster.

1. Ask only for what is missing (name, platform, manager/worker); offer a default.
2. Call `crew_add_member`.
3. Tell the human exactly how to bring that session up — the box id it will claim
   and `crew onboard` in the new session. For another machine, that machine needs
   the crew-agent daemon first (see `crew-selfhost`), then mail its box
   `SPAWN codex` / `SPAWN claude-code`.
4. Report the new roster with `show_roster`.

Names must be unique within a team; propose an alternative instead of failing.
