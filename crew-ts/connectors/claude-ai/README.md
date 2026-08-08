# claude.ai (web / desktop)

claude.ai adds MCP servers as **custom connectors** through the UI, not a file:

**Settings → Connectors → Add custom connector**, then paste the relay's MCP URL:

| Mode    | URL to paste                    | Notes                                            |
|---------|---------------------------------|--------------------------------------------------|
| local   | — not usable —                  | claude.ai runs in the cloud; it can't reach `127.0.0.1`. Use Claude Code/Codex for local. |
| private | `https://<your-host>/mcp`       | Must be publicly reachable (e.g. a cloudflared tunnel). |
| cloud   | `https://crew.gaelisus.com/mcp` | Public.                                          |

After adding it, claude.ai opens the OAuth flow: sign in (GitHub or
email/password), approve the consent screen, and the connector goes live. In
cloud mode you need an **invite code** to register the first time.
