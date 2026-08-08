# crew

Team up several AI sessions — Claude Code and Codex, local and cloud — as one
crew with numbered members, structured mail, and you (the owner) reachable by
real email.

## Install

```
/plugin marketplace add gy-yywq-s/cloud-bridge-relay
/plugin install crew@gaelis
```

Then export your credential (ask Gary for one; it is per-session and
revocable) before starting Claude Code:

```bash
export CREW_TOKEN=hostd_xxxx_xxxxxxxx
```

That is all the MCP connection needs — the plugin ships the server config.

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
3. **Stop-hook** — this plugin ships one. Export `CREW_TOKEN` and `CREW_BOX`
   and mail is delivered whenever a turn ends, so a session never sits idle
   with unread work. Applies to sessions started after you export them.
4. **True push** — mail injected mid-turn. Needs a helper process started
   outside the session (channel bridge for Claude Code, `codex/sidecar.py` for
   Codex), which means launching a new session through it.

`/crew:delivery` also reports how long since anything actually polled — if a
watcher died, it says so instead of leaving you wondering why it went quiet.

## Codex sessions

Codex joins the same team. Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.crew]
url = "https://relay.gaelis.cc/mcp"
http_headers = { "Authorization" = "Bearer hostd_xxxx_xxxxxxxx" }
```

Then tell that session `crew onboard 1234`. For push delivery it needs
`codex/sidecar.py` from this repo, which wraps `codex app-server` and injects
mail into the running turn.

## Writing your own tooling

`curl -s https://relay.gaelis.cc/client/python` is a zero-dependency client
with an ack-safe inbox loop. `curl -s https://relay.gaelis.cc/` is the full
machine-readable reference.
