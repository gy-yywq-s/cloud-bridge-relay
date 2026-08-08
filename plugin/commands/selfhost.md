---
description: Run your own crew relay, and make this machine spawnable
argument-hint: [local | private | cloud | agent | sidecar]
---
Set up crew locally for the owner. Topic: `$ARGUMENTS` (if empty, ask which of
the five below they want, then do that one).

Everything here is bundled with this plugin — the daemon and the sidecar are
real files at `${CLAUDE_PLUGIN_ROOT}/scripts/`, so nothing needs downloading.

Read the whole relevant section, run the commands for the owner where you can,
and tell them the one or two things only they can do (edit a secret, open a
port). Never print a secret you generated into chat history without saying so.

## 1. `local` — a relay for this machine only

No accounts, no exposure; loopback only. Best for "my laptop's sessions should
talk to each other".

```bash
git clone https://github.com/gy-yywq-s/cloud-bridge-relay ~/crew
cd ~/crew/crew-ts && npm ci && npm run build
CREW_MODE=local npm start          # MCP at http://127.0.0.1:8790/mcp
```

Point this session at it by writing `.mcp.json` in the project (or copy
`crew-ts/connectors/claude-code/local.mcp.json`):

```json
{ "mcpServers": { "crew": { "type": "http", "url": "http://127.0.0.1:8790/mcp" } } }
```

Then `/crew:onboard 1234` in each session on this machine.

## 2. `private` — your own devices, one shared crew

Reachable over a tunnel/LAN; OAuth in the browser, one trust domain (everyone
who can sign in sees the same crew). This is the self-host case.

```bash
cd ~/crew/crew-ts
cp crew.toml.example crew.toml     # set: mode="private", port, public_url
export CREW_SESSION_SECRET=$(openssl rand -hex 32)
export CREW_DEPLOYER_PASSWORD=$(openssl rand -hex 8)   # the browser login
# optional: RESEND_API_KEY + [email] in crew.toml for owner email
# optional: CREW_STATIC_TOKENS=tok-abc:watcher  for headless watchers
npm run build && npm start
```

Expose it (any public https origin works; a Cloudflare tunnel is easiest):

```bash
cloudflared tunnel create crew && cloudflared tunnel route dns crew crew.example.com
# ingress: crew.example.com -> http://127.0.0.1:<port>, then run the tunnel
```

`public_url` must equal that https origin — OAuth callbacks are built from it.
Sessions then use `https://crew.example.com/mcp` and log in through the browser.

## 3. `cloud` — public, invite-gated, one isolated crew per account

Same as `private` plus `mode="cloud"`, `open_registration=true`, and
`admin_emails=["you@example.com"]`. Each account gets its own database. Seed the
first admin (needs server access, which is the point):

```bash
node scripts/bootstrap-admin.mjs you@example.com 'a-strong-password'
```

Then sign in and generate invite codes at `/admin`.

## 4. `agent` — make a machine spawnable

A session can only spawn teammates on a machine where something is already
listening. Run this daemon there once and that machine can be given work later:

```bash
export CREW_URL=https://crew.example.com   # your relay
export CREW_TOKEN=...                      # a bearer the relay accepts
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-agent.mjs" --pool 1234 --name box-name
```

It registers into the pool, polls for mail, and on `SPAWN <platform>` launches a
local `claude` or `codex` session that joins the team. Keep it running (tmux,
`launchd`, or systemd `--user`).

## 5. `sidecar` — push delivery for Codex

Codex hooks cannot block a turn, so mail is injected into the running turn
instead. Wrap `codex app-server` with the bundled sidecar:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/codex-sidecar.py"
```

For Claude Code the equivalent is the Stop-hook watcher that ships with this
plugin — set `CREW_TOKEN` and `CREW_BOX` and it starts blocking idle stops with
unread mail (see `/crew:delivery`).

---

After any of these, confirm it works: open the relay's dashboard in a browser
(`<public_url>/app`) and check the session appears under Sessions.
