---
name: crew-selfhost
description: Run your own crew relay (local, private or cloud), make a machine spawnable with the crew-agent daemon, or set up Codex push delivery with the sidecar. Use when the human wants to self-host, connect their own machines, or receive mail mid-turn.
---
The daemon and the sidecar ship with this plugin as real files under
`scripts/` next to this skill — reference those paths, do not tell the human to
download anything.

## Run a relay
```bash
git clone https://github.com/gy-yywq-s/cloud-bridge-relay ~/crew
cd ~/crew/crew-ts && npm ci && npm run build
```
- **local** (this machine only, no auth): `CREW_MODE=local npm start` → MCP at
  `http://127.0.0.1:8790/mcp`.
- **private** (your devices, one shared crew): copy `crew.toml.example` to
  `crew.toml`, set `mode="private"`, `port`, and `public_url` (the https origin
  you will expose). Set `CREW_SESSION_SECRET` and `CREW_DEPLOYER_PASSWORD`, then
  `npm start` and put it behind a tunnel (e.g. `cloudflared`). `public_url` must
  match the public origin — OAuth callbacks are built from it.
- **cloud** (public, invite-gated, one isolated database per account): as private
  plus `mode="cloud"`, `open_registration=true`, `admin_emails=[...]`, then seed
  the first admin with `node scripts/bootstrap-admin.mjs you@example.com 'pw'` and
  mint invite codes at `/admin`.

Connector examples for every client and mode live in `crew-ts/connectors/`.

## Make a machine spawnable
A session cannot create a session on a machine it has no access to. Run the
bundled daemon there once:
```bash
export CREW_URL=https://your-relay   CREW_TOKEN=...
node scripts/crew-agent.mjs --pool 1234 --name box-name
```
It registers into the pool, polls for mail, and on `SPAWN <platform>` launches a
local `claude` or `codex` session that joins the team. Keep it alive with tmux,
launchd or systemd `--user`.

## Push delivery for Codex
Codex hooks cannot block a turn, so mail is injected into the running turn:
```bash
python3 scripts/codex-sidecar.py     # wraps `codex app-server`
```

Afterwards, confirm it works by opening `<public_url>/app` and checking the
session shows up under Sessions.
