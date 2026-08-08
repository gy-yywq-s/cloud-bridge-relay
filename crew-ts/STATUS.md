# crew-ts — build status & continuation plan

TypeScript rewrite of the crew relay, for release. Stack chosen after evaluating
what TS unlocks (all authoritative, all better than the Python side):

| Concern | Library | Why |
|---|---|---|
| MCP server | `@modelcontextprotocol/sdk` | the reference implementation; richer than Python |
| MCP over HTTP + OAuth | `@hono/mcp` | `StreamableHTTPTransport` + `mcpAuthRouter` + `ProxyOAuthServerProvider` + DCR/PKCE handlers, Hono-native |
| HTTP server | `hono` + `@hono/node-server` | one framework for MCP transport, REST, OAuth, web UI |
| DB | `better-sqlite3` | synchronous, direct analog of Python sqlite3 |
| Email | `resend` | official SDK |
| Passwords | `@node-rs/argon2` | argon2, Rust-backed, no native build pain |
| Config | `smol-toml` + `zod` | toml + validated schema |
| GitHub login (cloud web) | `arctic` (planned) | see auth note below |

## Done and tested (committed)

- **Config system** (`config.ts`): three profiles (`local`/`private`/`cloud`),
  every previously-hardcoded default externalized (limits, timers, templates,
  branding, email, pool-code digits, owner default mode…). Env overrides.
- **DB** (`db.ts`): full schema incl. OAuth + accounts tables (unused until
  auth lands) and `roster_seen` for the change-aware footer.
- **Core port** (`core/*.ts`), faithful to the Python:
  boxes/roster/team-card, mail (templates, gating, rate limit, dedup, threads,
  ack model, board reminder, change-aware footer), teams (pools, init, join,
  roles, view keys, server-minted box ids, name-uniqueness), tasks (atomic
  claim, deps + auto-unblock, stall detection, mail↔board welding), wizard
  (server-driven interview: batch questions/answers + one-at-a-time; setters
  hard-locked until done), owner mailbox (setup/confirm/edit, mode gating,
  Resend delivery), sweeps (watcher-vs-pull-only stale detection).
- **MCP server** (`mcp/server.ts`): 31 tools + `onboard`/`setup` prompts,
  ToolAnnotations for read/write grouping.
- **REST mirror + entry** (`index.ts`): full parity endpoints, `/mcp` transport,
  `/health`, sweeps started.
- **Verified**: `tsc` clean (0 errors); local-mode e2e over REST AND over a real
  MCP client (31 tools discovered, onboard→batch setup→answers→done→handoff
  auto-task→result auto-close→rate-limit→board→setup-guard all pass).

## Pending (in priority order)

1. **Subagent code review** is running; apply its findings first.
2. **OAuth 2.1 authorization server** for MCP (`private`/`cloud`), via
   `@hono/mcp`'s `mcpAuthRouter` + an `OAuthServerProvider` backed by the
   `oauth_*` tables (authorize + token + refresh + DCR + PKCE). This is the
   authoritative path claude.ai / Claude Code speak. `local` stays no-auth.
3. **Web UI** (ode design tokens captured below) — status + config editing +
   team/pool ops (not register); broadcast on change. Board site folds in here.
4. **GitHub login for the cloud web UI** — see auth note.
5. **Deploy** to droplet as non-root `crew` user (systemd + own cloudflared
   tunnel → `crew.gaelisus.com`). ONLY after 1–4 are complete and reviewed;
   the Python relay stays live until then (do not ship a half-rewrite over it).
6. **`crew_add_member`** (register directly against a team + single-member
   mini-interview) and the **spawn workflow**.

## Auth evaluation (Gary asked about Auth.js)

Two DISTINCT auth roles — do not conflate:

- **crew as an OAuth 2.1 *authorization server*** (MCP clients connect to it):
  this is `@hono/mcp` + MCP SDK's provider interface. **Auth.js cannot do this**
  — Auth.js is a relying party (login *with* a provider), not an AS.
- **Human web login** (dashboard, cloud mode) incl. "log in with GitHub":
  Auth.js is coupled to Next.js and awkward in a standalone Hono server.
  Recommendation: **`arctic`** (lightweight OAuth *client* by the Lucia author,
  the modern authoritative choice for standalone servers) for the GitHub flow,
  plus argon2 for email/password accounts, plus a signed-cookie session. Hono's
  `@hono/oauth-providers` is a viable alternative but arctic is cleaner.

Verdict: **not Auth.js.** MCP AS = MCP SDK; human GitHub login = arctic.

## Spawn workflow — Gary's bootstrapping insight (design, not yet built)

A session cannot spawn a session on a machine it has no access to, and MCP only
runs while a session runs — so cross-machine spawn needs a **crew-agent daemon**
the user runs on each spawnable machine ("advance preparation"): a small
long-running process (generalized sidecar) that authenticates to crew and, on a
spawn request, launches a local `claude`/`codex` session with an injected
`CREW_TOKEN` + pool code. Same-machine spawn uses the host's native mechanism
(Claude Code Task/agent tools; `codex exec`) — crew stays the coordination
layer and never owns permissions/workspace/model, which remain with the native
spawn. `crew_spawn_guide(team, pool)` will return the platform-specific recipe
(env vars to inject, model/cwd params) rather than spawning itself.

## ode design tokens (for the Web UI; main surface pure white, accent placeholder)

- fonts: `--sans` = ui-sans-serif/-apple-system/SF Pro (NO serif per Gary);
  `--mono` = ui-monospace/SF Mono.
- radii: 10/12/14px cards, 4–5px chips. shadows: layered warm-tinted
  `0 1px 2px rgba(30,24,12,.05), 0 5px 16px rgba(30,24,12,.08)` (`--cast`).
- motion: `--fast 130ms / --mid 240ms / --slow 420ms`, ease
  `cubic-bezier(.22,.61,.36,1)`, spring `cubic-bezier(.2,.9,.3,1.06)`;
  animations pop/rowIn/toastIn/rise/fadeIn.
- surfaces: pure white `#ffffff` (Gary's call), text `#191714`, muted `#55514a`,
  rules `#ddd9d2`; accent placeholder indigo `#1c4f8f` (Gary picks final).
- light + dark both (token swap).
