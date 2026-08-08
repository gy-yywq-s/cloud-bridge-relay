---
description: Set up or edit the owner mailbox (real email delivery)
---
Set up the owner mailbox so the team can reach the human by email.

1. Ask the owner, one at a time: full name, display alias, real email address.
2. Call `setup_owner_mailbox(full_name, email, alias)`. This sends a
   verification email.
3. ASK whether it arrived. Only when they say yes, call
   `confirm_owner_mailbox()`. Never confirm on your own.
4. If sending FAILED, read the exact error to them. They may fix it and retry,
   or explicitly say "override" — only then call
   `confirm_owner_mailbox(override=true)`.
5. Then ask which receive mode they want (a / b / c / d) and call
   `set_owner_mode`. For `d`, translate their wording into hard rules, read
   them back, get an explicit yes, and ask whether to keep it permanently.

Editing later: run this again. Same email = name/alias update only, no
re-verification. A new email restarts verification.
