---
name: crew-spawn
description: Bring another AI session into the crew — on this machine or another one. Use when the human wants more members, a teammate on a second machine, or asks how to spawn a session.
---
1. Find the team with `list_boxes` if no id was given.
2. Call `spawn_guide(team, platform)` and follow the recipe it returns for that
   platform rather than improvising.
3. Say WHERE the new session will run:
   - this machine, by hand → give the one line the human pastes in a new terminal;
   - another machine → you cannot reach it. A session only appears where something
     is already listening, so that machine must be running the crew-agent daemon
     (see the `crew-selfhost` skill). If it is, mail its box `SPAWN codex` or
     `SPAWN claude-code` and it will launch a session that joins this team.
4. If setup already finished, use `crew_add_member` so the newcomer gets a number,
   a role and a mailbox without re-running the interview.
5. Report the new roster with `show_roster`.

Never spawn more sessions than asked — each one costs the human money.
