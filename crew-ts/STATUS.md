# crew-ts — status & deploy runbook

TypeScript rewrite of crew, for release. **Complete and tested in local, private,
and cloud (multi-tenant) mode, and deployed** to staging at
`https://crew-ts.gaelisus.com` (private mode) on codex-droplet. Cloud multi-tenant
isolation is built, tested (27/27 e2e), and security-reviewed twice.

## Done + tested

- **Stack**: `@modelcontextprotocol/sdk` + `@hono/mcp` (transport **and** OAuth
  2.1 AS) + Hono + better-sqlite3 + resend + `@node-rs/argon2` + `arctic`
  (GitHub login) + zod + smol-toml.
- **Config** `crew.toml` — three profiles (local/private/cloud), every default
  externalized; env overrides.
- **Core** (faithful port, reviewed once, review fixes applied): mail
  (templates, gating, rate limit, dedup, threads, ack, change-aware footer),
  teams (pools, init, join, roles, view keys, minted box ids, name-uniqueness,
  **crew_add_member** for post-setup joins), tasks (atomic claim, deps,
  stall detection, mail↔board welding), wizard (batch + single, setter lock),
  owner mailbox (Resend), sweeps (watcher-vs-pull-only).
- **MCP**: 34 tools + onboard/setup prompts + **spawn_guide**.
- **OAuth 2.1 AS**: DCR + PKCE + code/token/refresh/revoke, SQLite-backed,
  served by `mcpAuthRouter`. Data plane (`/mcp`, `/api/*`) gated by bearer when
  mode≠local; static tokens + deployer password for private mode. **Explicit
  consent screen + double-submit CSRF** before any authorization code is minted
  (no code is ever issued on a GET).
- **Cloud multi-tenancy (database-per-tenant)**: each account gets a physically
  separate SQLite file (`data/tenants/<id>/crew.db`); control plane (accounts,
  OAuth, invites) stays in the shared `crew.db`. `tenantCtx()` is the single
  routing point — every request's business logic runs against the Ctx scoped to
  the accountId from its verified bearer, so isolation is structural, not a
  forgettable WHERE filter. LRU-bounded handle cache. private/local remain one
  shared trust domain (tenantCtx returns the shared Ctx).
- **Invite-gated open registration**: single-use (atomic consume) / multi-use /
  expiring codes, minted by admins. Admins bootstrap without an invite; the very
  first admin is seeded by `scripts/bootstrap-admin.mjs` (operator/file access)
  or a GitHub-verified admin email — never from a self-asserted signup email.
- **Admin console** (`/admin`, cloud): aggregate activity only (accounts, active
  users, per-account team/agent/message counts + last-active) — never message or
  task content — plus invite generation/disable. Admin status requires a proven
  email (GitHub-verified or operator bootstrap).
- **Web UI** (ode design, **single swappable `--accent`**, pure-white surface,
  light+dark): `/login` (email+password, GitHub, deployer), `/signup`
  (gated by open_registration), `/app` dashboard (teams, pools, sessions,
  live board/roster, initialize/rename/roles).
- **crew-agent** daemon (`agent/crew-agent.mjs`): the pre-run process that makes
  a machine spawnable (Gary's bootstrapping insight); launches local
  claude/codex on a SPAWN mail.
- **Verified**: `tsc` 0 errors. Local e2e (REST + real MCP client, 34 tools):
  register→team→batch setup→handoff auto-task→result auto-close→rate-limit→
  board→setup-guard→add-member. Private mode: OAuth metadata, DCR, 401/200
  gating on /mcp+/api, login page, swappable theme, crew-agent register.

## Deploy runbook (droplet, as non-root `crew` user)

Blocks on Gary: (1) a **GitHub OAuth app** (Settings→Developer settings→OAuth
Apps) with callback `https://<host>/auth/github/callback` → `GITHUB_CLIENT_ID`
/`GITHUB_CLIENT_SECRET`; (2) which host — recommend **staging first**
(`crew-ts.gaelisus.com`) so the live Python relay at `crew.gaelisus.com` keeps
serving until the TS version is proven, then cut `crew.gaelisus.com` over.

```bash
# as root, one-time:
adduser --system --group --home /home/crew crew
# node 20+ available system-wide (nvm or nodesource); better-sqlite3 + argon2 build native
sudo -u crew -H bash -lc '
  git clone https://github.com/gy-yywq-s/cloud-bridge-relay ~/app
  cd ~/app/crew-ts && npm ci && npm run build
  cat > ~/app/crew-ts/crew.toml <<TOML
  mode = "cloud"          # or "private"
  port = 8899
  public_url = "https://crew-ts.gaelisus.com"
  [brand]
  name = "crew"
  [auth]
  open_registration = true
  TOML
'
# secrets in the systemd unit (NOT in the repo): GITHUB_CLIENT_ID/SECRET,
# CREW_SESSION_SECRET (openssl rand -hex 32), RESEND_API_KEY, CREW_STATIC_TOKENS.
# systemd unit runs: node /home/crew/app/crew-ts/dist/index.js  (User=crew)
# cloudflared: new tunnel + DNS route crew-ts.gaelisus.com -> http://127.0.0.1:8899
```
Then connect the three clients to `https://crew-ts.gaelisus.com/mcp` (OAuth) and
run the live cross-platform + spawn tests. Only after that, flip
`crew.gaelisus.com` DNS to the TS tunnel and migrate/retire the Python relay.

## Known gaps

- **Elicitation** (native setup form) not yet ported to TS (batch fallback works).
- Live 3-client + spawn e2e over the public OAuth flow still to be run by Gary
  (machinery verified; the browser-login step is interactive).

## Security reviews (both applied)

1. auth/web layer: anonymous-token-mint (separate oauth_pending table),
   refresh-as-bearer, refresh rotation, redirect_uri binding, JWT exp, esc.
2. cloud multi-tenancy: **verdict — data-at-rest isolation sound** (separate
   files, accountId always from the verified bearer, control plane fails closed,
   static-token/deployer/null paths neutered in cloud). Two HIGH findings fixed:
   (1) session→code auto-approve now behind consent + CSRF; (2) admin/invite
   bypass no longer honored from an unverified email. Two LOW fixed (tenantDb
   LRU; GitHub email-collision guard).

## Design notes carried forward

- Auth verdict: MCP AS = MCP SDK/@hono/mcp; human GitHub login = `arctic` (NOT
  Auth.js — it's a client library coupled to Next.js, can't be an AS).
- Theme: recolor by swapping `--accent` (and optionally the neutral tokens) in
  `web/theme.ts`; no component rule uses a raw colour.
- Python relay stays live at crew.gaelisus.com throughout; nothing here touched it.
