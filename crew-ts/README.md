# crew (TypeScript)

The self-hostable, release build of crew: a relay that teams up several AI coding
sessions (Claude Code + Codex + claude.ai) as one crew — numbered members,
templated mail, a shared task board, guided setup, and the human owner reachable
by real email. Everything is server-side, so a team survives sessions crashing,
restarting, or moving between machines.

This is the TypeScript rewrite of the original Python relay (`../relay.py`),
built around the official MCP TypeScript SDK with a full OAuth 2.1 authorization
server, a web dashboard, and — in cloud mode — per-account data isolation.

## Three deployment modes

One binary, one config field (`mode`). Pick the one that matches how you'll use it:

| Mode        | Who connects                         | Auth                                   | Data model                                  | Set up |
|-------------|--------------------------------------|----------------------------------------|---------------------------------------------|--------|
| **local**   | sessions on **this machine** only    | none (loopback)                        | one database                                | fastest — just run it |
| **private** | your devices over a tunnel/LAN — **one trust domain** | OAuth (browser) or a preset static token | one shared database (everyone sees one crew) | run + expose behind your own tunnel |
| **cloud**   | the public, **invite-gated** signup  | OAuth + GitHub login                    | **database-per-account** — full isolation   | run + tunnel + set admins + mint invites |

- **local** — you're driving Claude Code and Codex on your laptop and want them
  to coordinate. No accounts, no exposure.
- **private** — your own sessions across machines (laptop + a cloud box + a
  phone via claude.ai) sharing one crew. A single trust domain: anyone who can
  authenticate sees the same teams. This is the "self-host it for just me / my
  team" case.
- **cloud** — a public instance where strangers register their own accounts
  (with an invite) and each gets a completely isolated crew of their own. This is
  the multi-tenant SaaS shape.

See [`crew.toml.example`](crew.toml.example) for every setting.

## Quick start

```bash
npm ci && npm run build

# local (no auth, loopback)
CREW_MODE=local npm start                    # MCP at http://127.0.0.1:8790/mcp

# private / cloud: copy crew.toml.example -> crew.toml, set mode + public_url,
# provide secrets via env (systemd EnvironmentFile in production):
#   CREW_SESSION_SECRET=$(openssl rand -hex 32)
#   RESEND_API_KEY=...            # optional, owner email
#   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   # optional, GitHub login
#   CREW_STATIC_TOKENS=tok:label  # private-mode headless watchers
CREW_CONFIG=./crew.toml npm start
```

## Connecting clients

Ready-to-copy configs for every client × mode live in
[`connectors/`](connectors/) (Claude Code, Codex, and claude.ai). The short
version: point the client at `<url>/mcp`; for private/cloud the client runs the
OAuth browser flow automatically (you sign in and approve a consent screen) —
no token to paste.

## Cloud mode: admins & invites

- **Admins** are the emails in `auth.admin_emails` (or `CREW_ADMIN_EMAILS`).
  They see aggregate activity (accounts, active users, per-account team/agent/
  message **counts** — never message or task content) and mint invite codes at
  `/admin`.
- **Registration is invite-gated.** Admins generate single-use, multi-use, or
  expiring codes. New users register at `/login` with a code (or "Continue with
  GitHub" after entering one).
- **Seed the first admin** — since minting invites needs an admin, bootstrap one
  directly (requires server access, so it's the authoritative operator step):

  ```bash
  npm run build
  CREW_CONFIG=./crew.toml node scripts/bootstrap-admin.mjs you@example.com 'a-strong-password'
  ```

  Then sign in at `/login` and mint invites. (An admin whose **GitHub-verified**
  email is on the list also becomes admin automatically on GitHub login.)

## Security model

- **Data plane** (`/mcp`, `/api/*`) requires a valid bearer whenever `mode ≠
  local`. OAuth 2.1 authorization server (DCR + PKCE + code/token/refresh/revoke)
  served by `@hono/mcp`'s `mcpAuthRouter`.
- **Consent + CSRF**: an authorization code is only ever minted from an explicit
  consent POST carrying a session-bound CSRF token — never on a bare GET.
- **Cloud isolation is structural**: each account's teams/mail/tasks live in a
  physically separate SQLite file; a request only ever resolves its own account's
  database (from its verified token). Not a `WHERE account_id` filter that a
  query could forget.
- **Admin requires a proven email** (GitHub-verified, or the bootstrap script) —
  never a self-asserted signup email.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | entry: Hono app, MCP endpoint, REST mirror, auth wiring, sweeps |
| `src/core/` | mail, teams, tasks, wizard, owner mailbox, sweeps, **tenancy** |
| `src/mcp/server.ts` | the MCP tools + prompts |
| `src/auth/` | OAuth 2.1 store, accounts (argon2 + GitHub via arctic), invites, web routes |
| `src/web/` | dashboard (`/app`), admin console (`/admin`), theme (swappable `--accent`) |
| `agent/crew-agent.mjs` | pre-run daemon that makes a machine spawnable |
| `connectors/` | client × mode connection examples |
| `scripts/bootstrap-admin.mjs` | seed/promote an admin account |

MIT — see [`../LICENSE`](../LICENSE).
