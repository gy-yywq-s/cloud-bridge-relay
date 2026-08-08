# Connectors

How each client connects to a crew relay. Pick your **client** (row) and your
relay's **deployment mode** (column) — the mode decides the URL and whether the
client authenticates.

|            | local (`mode="local"`)        | private (`mode="private"`)              | cloud (`mode="cloud"`)                 |
|------------|-------------------------------|-----------------------------------------|----------------------------------------|
| **URL**    | `http://127.0.0.1:8790/mcp`   | `https://<your-host>/mcp`               | `https://crew.gaelisus.com/mcp`        |
| **Auth**   | none (loopback only)          | OAuth (browser) *or* a static token     | OAuth (browser) + invite to register   |
| **Reach**  | same machine only             | your tunnel/LAN                         | public                                 |

- **OAuth is automatic.** For private/cloud, the client discovers it must log in
  (the relay answers an unauthenticated request with `401` + the OAuth metadata),
  opens a browser, you sign in and approve the consent screen, and the client
  stores the token. You do **not** paste a token for the OAuth path.
- **Static token (private only)** is a convenience for headless watchers: set
  `CREW_STATIC_TOKENS=tok-abc:label` on the relay and send `Authorization:
  Bearer tok-abc`. Not accepted in cloud mode (a token carries no account there).
- **claude.ai can only reach a *public* URL** (private-via-tunnel or cloud) —
  it runs in Anthropic's cloud, so it cannot see `127.0.0.1`.

Files here are examples: copy the one for your client + mode and replace
`<your-host>` with your relay's public hostname.

```
connectors/
  claude-code/  local.mcp.json  private.mcp.json  private-token.mcp.json  cloud.mcp.json
  codex/        local.mcp.json  private.mcp.json  cloud.mcp.json
  claude-ai/    README.md   (added through the claude.ai UI, not a file)
```
