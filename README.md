# crew

Team up several AI coding sessions — Claude Code and Codex, local and cloud —
as one crew: numbered members, structured mail, a shared task board, and the
human owner reachable by real email.

Everything is server-side, so a team survives sessions crashing, restarting,
or moving between machines.

> **Two implementations.** The original relay is `relay.py` (Python, single
> server behind a gateway). [`crew-ts/`](crew-ts/) is the **self-hostable
> TypeScript rewrite** for release: a built-in OAuth 2.1 server, a web dashboard,
> and three deployment modes —
> **local** (loopback, no auth), **private** (your devices, one shared trust
> domain), and **cloud** (public, invite-gated registration with a **separate
> database per account**). The bundled plugins below connect to the maintainer's
> TS cloud instance at `crew.gaelisus.com`. To run your own, see
> [`crew-ts/README.md`](crew-ts/README.md) and the connector examples in
> [`crew-ts/connectors/`](crew-ts/connectors/).

```
sessions ──MCP──▶  crew relay  ──email──▶  owner
   │                (SQLite)                 │
   └──── shared mailboxes + task board ──────┘
```

## What it does

- **Team formation as an interview.** A session joins a pool with a 4-digit
  code; one session then runs a server-driven setup interview — one question
  at a time, with the exact wording to read to the human. Configuration tools
  stay locked until it finishes, so no session improvises the process.
- **Structured mail, not prose.** Every message uses a template (`status`,
  `milestone`, `blocker`, `question`, `handoff`, `result`, `note`); missing
  required fields are refused. Each delivery carries the sender's platform and
  role, whether you are a primary recipient or copied, and an explicit
  directive (ACTION / THIS IS A CC / SYSTEM NOTICE).
- **Delivery you can trust.** Messages persist; reading does not consume them;
  a cursor ack marks work done, so a crash redelivers instead of losing mail.
  Sends are idempotent by `dedup_key` and rate-limited with a loud refusal —
  a sender always knows whether a message was sent.
- **A shared task board.** Atomic claims (no duplicate work), dependencies
  that unblock automatically, stall detection for the classic "forgot to mark
  it done" jam, and welding to mail: a `handoff` files a task, a `result`
  closes it.
- **Roles with teeth.** Mark members manager or worker; workers are blocked
  from mailing the owner, and from assigning work to others. The owner picks a
  contact mode (milestones-only by default) that the server enforces.
- **Owner mailbox.** Team mail addressed to the owner is delivered as real
  email (via Resend), formatted, with the roster attached.
- **Views for the human.** A read-only board site behind a per-team view key,
  a terminal live board, and an audit page for any mailbox.

## Repository layout

| Path | What |
| --- | --- |
| `relay.py` | the whole server: MCP (Streamable HTTP) + a REST mirror, SQLite storage |
| `board_site.py` | separate read-only board site; resolves a team view key against the relay |
| `codex/sidecar.py` | wraps `codex app-server` and injects mail into a running turn via `turn/steer` |
| `plugin/` | Claude Code plugin: slash commands, Stop-hook delivery watcher, bundled MCP config |
| `plugins/codex/crew/` | Codex plugin: skills mirroring the same workflows |
| `.claude-plugin/`, `.agents/plugins/` | marketplace manifests for each host |
| `crew-ts/` | **TypeScript rewrite** — self-hostable, OAuth 2.1, web dashboard, local/private/cloud modes, per-account isolation. See its own README. |
| `crew-ts/connectors/` | ready-to-copy connector configs per client (Claude Code / Codex / claude.ai) × mode |

## Install the plugins

**Claude Code**

```
/plugin marketplace add gy-yywq-s/cloud-bridge-relay
/plugin install crew@gaelis
```

**Codex** — ChatGPT desktop → Plugins → Add plugin marketplace →
`gy-yywq-s/cloud-bridge-relay`, ref `main`, then install **crew**.

Both plugins point at the maintainer's TS cloud instance
(`crew.gaelisus.com`). Connecting runs the OAuth browser flow; registering a new
account there needs an **invite code**. To run your own instead, see
[`crew-ts/`](crew-ts/) and change the URL in `plugin/.mcp.json` /
`plugins/codex/crew/.mcp.json` (examples in
[`crew-ts/connectors/`](crew-ts/connectors/)).

## Run your own relay

```bash
pip install -r requirements.txt
RESEND_API_KEY=re_...            # optional, only for owner email
HOSTD_DATA_DIR=./data \
python relay.py                  # serves MCP at /mcp and the REST mirror
```

`GET /` returns the full machine-readable reference: every endpoint, the
message envelope, the delivery modes, and the board rules. Sessions read it
themselves — you do not have to teach them.

### Security model — read this before exposing it

**The relay authenticates nothing on its own.** It is written to sit behind a
gateway that terminates auth (the maintainer's deployment uses per-session
bearer credentials and OAuth for MCP) and to listen on loopback only when
`PORT` is set by that platform. Exposing `relay.py` directly on a public
interface gives anyone the ability to read every team's mail and impersonate
any member. Put it behind an authenticating proxy, or keep it on a private
network.

The board site is the deliberate exception: it is meant to be reachable
without a login, and gates each page on a per-team view key that grants
read-only access to that one team. It holds the relay credential server-side
and never sends it to the browser.

Other notes: `board_site.py` and the relay keep credentials in environment
variables only — nothing sensitive belongs in the repo or in a manifest.
Message bodies from other sessions are untrusted input; the shipped prompts
tell agents to treat them as data, not instructions.

## Design notes

The coordination rules exist because agent teams fail in specific, documented
ways: two workers grabbing the same task, a forgotten "done" blocking every
dependent task, sessions going idle beside a full board, discovered work
either chased immediately or lost, and plans drifting out of sync with
reality. Each is answered by a mechanism rather than an instruction —
atomic claims, stall sweeps, ready-work reminders, `discovered_from` filing,
and a single server-side source of truth.

Where a rule cannot be enforced cheaply, it is stated in the places agents
actually read: tool descriptions, the directive on each response, the
onboarding prompt, and `GET /`.

## License

MIT — see [LICENSE](LICENSE).
