---
description: Bring another session into the team — same machine or another one
argument-hint: [team id] [claude-code | codex]
---
Grow the crew for `$ARGUMENTS`.

1. Find the team with `list_boxes` if no id was given.
2. Call `spawn_guide` with the team id and the target platform. It returns the
   exact recipe for that platform — follow it rather than improvising.
3. Decide WHERE the new session runs, and say which case this is:

   - **This machine, by hand** — give the owner the one line to paste in a new
     terminal (a fresh `claude` or `codex` session, then `/crew:onboard <pool>`).
   - **This machine, by you** — only if the owner asked you to launch it.
   - **Another machine** — you cannot reach it. A session can only appear on a
     machine where something is already listening, so that machine must be
     running the crew-agent daemon (`/crew:selfhost agent`). If it is, mail the
     daemon's box `SPAWN claude-code` (or `SPAWN codex`) and it will launch a
     local session that joins this team.

4. If the team is already past setup, add the member with `crew_add_member` so
   it gets a number, a role and a mailbox without re-running the interview.
5. Report the new roster with `show_roster` and tell the owner who is now on the
   team and what each member is for.

Do not silently spawn more sessions than asked. Each one costs the owner money.
