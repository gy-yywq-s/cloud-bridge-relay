---
name: crew-ownermail
description: Set up or edit the crew owner mailbox (real email delivery to the human). Use when the human wants team mail reaching their email.
---
1. Ask the owner, one at a time: full name, display alias, real email.
2. Call `setup_owner_mailbox(full_name, email, alias)` — sends a verification
   email.
3. ASK whether it arrived. Only on their yes call `confirm_owner_mailbox()`.
   Never confirm on your own.
4. If sending FAILED, read the exact error to them; they may fix and retry or
   explicitly say "override" → `confirm_owner_mailbox(override=true)`.
5. Ask which receive mode they want (a default / b / c / d) →
   `set_owner_mode`; for `d`, translate their wording into hard rules, read
   back, get an explicit yes, ask if permanent.

Editing later: same email = instant name/alias update; new email restarts
verification.
