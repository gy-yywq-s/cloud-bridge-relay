# crew-ts — status & deploy runbook

TypeScript rewrite of crew, for release. **The software is complete and tested
in local + private mode.** What remains is the droplet deploy, which blocks on
inputs only Gary can supply (a GitHub OAuth app, the domain cutover decision),
plus cloud multi-tenancy (see Known gaps).

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
  mode≠local; static tokens + deployer password for private mode.
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

## Known gaps (must close before public cloud)

- **Cloud multi-tenancy is NOT implemented.** teams/boxes/tasks/mail are global;
  with `open_registration=true` every registered stranger can read every team.
  `private` mode (single trust domain — Gary's own cross-device use, and the
  "anyone self-hosts their own" case) is fine as-is. Cloud needs account_id
  scoping on every query (columns already exist). Do this before exposing
  cloud publicly.
- **Second security review** of auth/web is running; apply findings.
- **Elicitation** (native setup form) not yet ported to TS (batch fallback works).
- Live 3-client + spawn e2e pending the deploy.

## Design notes carried forward

- Auth verdict: MCP AS = MCP SDK/@hono/mcp; human GitHub login = `arctic` (NOT
  Auth.js — it's a client library coupled to Next.js, can't be an AS).
- Theme: recolor by swapping `--accent` (and optionally the neutral tokens) in
  `web/theme.ts`; no component rule uses a raw colour.
- Python relay stays live at crew.gaelisus.com throughout; nothing here touched it.
