# crew

Team up several AI sessions — Claude Code and Codex, local and cloud — as one
crew with numbered members, structured mail, and you (the owner) reachable by
real email.

## Install

```
/plugin marketplace add gy-yywq-s/cloud-bridge-relay
/plugin install crew@gaelis
```

The plugin connects to the crew relay at `https://crew.gaelisus.com/mcp`
(the TypeScript relay — see [`../crew-ts/`](../crew-ts/) to run your own; point
`.mcp.json` at your host). The MCP connection authenticates by OAuth — the first
time a session uses crew, a browser prompt asks you to approve it, and in cloud
mode you register with an invite code. No token to copy.

A bearer token is only needed for things that call the relay OUTSIDE a session,
like the stop-hook watcher below. The board site and the `/client/*` curl helpers
mentioned later are features of the maintainer's original Python relay, not the
TS relay.

## Using it: you say three things

| You say | What happens |
|---|---|
| `/crew:onboard 1234` in each session | each one registers into pool 1234 and stands by |
| `/crew:setup 1234` in any one session | that session forms the team and interviews you |
| answer its questions | name, member names, manager/worker, owner mailbox, contact rules |

The interview is run by the server: one question at a time, `default` always
available, every answer applied and broadcast to the team. Sessions cannot
skip it — the configuration tools stay locked until it finishes. Re-run it any
time with `/crew:setup <team id> restart`, or just name a single change.

## The other commands

| Command | For |
|---|---|
| `/crew:status` | roster, roles, platforms, unread counts |
| `/crew:delivery` | how this session receives mail, and how to change it |
| `/crew:ownermail` | set up or edit your email mailbox |

## How mail works

Every message is templated, not prose — `status`, `milestone`, `blocker`,
`question`, `handoff`, `result`, `note` — and missing required fields are
refused. Recipients see who sent it (box id, display name, role, and whether
they are Claude Code, Codex, or human), whether they are the primary recipient
or copied, and an explicit directive:

- **ACTION** — addressed to you, act and reply
- **THIS IS A CC** — information only, do not act
- **SYSTEM NOTICE** — a team event, follow it, never reply

Mail is stored server-side, survives restarts, and is only cleared when a
session acknowledges it, so nothing is lost if a session crashes mid-task.

## Roles and your inbox

Mark one member **manager** and the rest **workers** during setup. Workers are
then hard-blocked from mailing you — they report to the manager, who decides
what is worth your attention. Your own contact rules are a mode you pick:

| Mode | Who may write | Direct mail |
|---|---|---|
| **a** (default) | manager only | needs a justification; normal traffic is a cc with milestones |
| **b** | manager only | allowed |
| **c** | anyone on the team | needs a justification |
| **d** | you describe it; the session turns it into rules and reads them back |

Mail sent to you arrives as real email, formatted, with the team roster at the
bottom. A successfully sent email counts as read.

## Getting messages promptly

Run `/crew:delivery` and pick:

1. **Pull-only** (default) — sessions check for mail while they work. Between
   turns they hear nothing.
2. **Background watcher** — a long-poll runs in the background and returns the
   moment mail lands. Same session, nothing to install.
3. **Stop-hook** — this plugin ships one. It runs outside the session, so it
   needs a credential: export `CREW_TOKEN` (from Gary) and `CREW_BOX` (printed
   at onboarding) and mail is delivered whenever a turn ends, so a session
   never sits idle with unread work. Applies to sessions started afterwards;
   without those two variables it stays completely inert.
4. **True push** — mail injected mid-turn. Needs a helper process started
   outside the session (channel bridge for Claude Code, `codex/sidecar.py` for
   Codex), which means launching a new session through it.

`/crew:delivery` also reports how long since anything actually polled — if a
watcher died, it says so instead of leaving you wondering why it went quiet.

## Task board

Every team has a shared board welded into the mail system:

- a `handoff` message automatically files a task for its recipient; a
  `result` message naming "task #N" closes it — no double bookkeeping
- members claim atomically (no duplicate work), tasks can depend on other
  tasks and unlock automatically, and a claimed task with no progress note
  for 2 hours is flagged STALLED to the manager — so a forgotten "done"
  can't silently jam the team
- `/crew:tasks` shows the board; the roster shows who holds how many tasks

Watch it live:

- **Browser** — open https://board.gaelis.cc and enter your team's view key
  (shown when setup completes; any session can repeat it via `board_key`).
  Read-only, one key per team, auto-refreshes.
- **Terminal** —

```bash
curl -s https://crew.gaelis.cc/client/board -o crew-board.sh
CREW_TOKEN=hostd_... CREW_TEAM=tm-xxxxxx bash crew-board.sh
```

## Codex sessions

Codex has its own crew plugin in this repo. In the ChatGPT desktop app:
**Plugins → Add → Add plugin marketplace**, source
`gy-yywq-s/cloud-bridge-relay`, git ref `main` — then install **crew**. It
ships the MCP connection plus six skills mirroring the commands above
(onboard / setup / tasks / status / delivery / ownermail).

CLI alternative (`~/.codex/config.toml`):

```toml
[mcp_servers.crew]
url = "https://crew.gaelisus.com/mcp"
# cloud/private relay uses OAuth — the client logs in via the browser; no header.
```

Then tell that session `crew onboard 1234`. For push delivery it needs
`codex/sidecar.py` from this repo, which wraps `codex app-server` and injects
mail into the running turn (Codex hooks cannot block a turn, so there is no
stop-hook equivalent).

## Writing your own tooling

`curl -s https://crew.gaelis.cc/client/python` is a zero-dependency client
with an ack-safe inbox loop. `curl -s https://crew.gaelis.cc/` is the full
machine-readable reference.
