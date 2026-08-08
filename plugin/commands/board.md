---
description: Get a read-only web link to this team's board, to share or watch
argument-hint: [team id]
---
Produce the shareable board link for `$ARGUMENTS` (find the team with
`list_boxes` if no id was given).

1. Call `board_key` for the team. It returns a short view key.
2. The board lives on the relay itself: `<relay base>/b/<key>` — the same host
   this session's MCP connection points at, with `/mcp` replaced by `/b/<key>`.
   Give the owner that full URL.
3. Say plainly what the link is: a read-only view of THIS team's task board and
   roster, no account needed, safe to hand to someone who should watch progress
   and nothing else. It shows no other team and no mail bodies.
4. If they want to stop sharing, tell them: any session can mint a fresh key with
   `board_key`, which is the way to rotate it.

Also mention the signed-in dashboard (`<relay base>/app`) if the owner wants the
full picture — teams, waiting pools, live sessions, settings — rather than one
board.
