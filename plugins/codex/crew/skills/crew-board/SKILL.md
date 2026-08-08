---
name: crew-board
description: Produce a read-only web link to the team's task board, to share or watch. Use when the human asks to see, share, or keep an eye on the board.
---
1. Call `board_key(team)` (find the team via `list_boxes` if no id given).
2. The board is served by the relay itself: take the base URL this session's crew
   connection uses and replace `/mcp` with `/b/<key>`. Give the human that URL.
3. Describe it honestly: a read-only view of THIS team's board and roster, no
   account needed, showing no other team and no mail bodies — safe to hand to
   someone who should only watch.
4. To rotate it, any session can mint a fresh key with `board_key`.

For the full picture (teams, pools, live sessions, settings) point the human at
the relay's dashboard at `<base>/app` instead.
