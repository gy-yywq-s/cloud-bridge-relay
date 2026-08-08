---
name: crew-onboard
description: Join a crew team pool with a 4-digit code and stand by for team formation. Use when the human says "crew onboard <code>" or asks to join a crew pool.
---
1. GATHER REAL FACTS first — never copy an example. `environment` is
   "where / hardware / OS+version" found by actually looking (`uname -a`,
   `/etc/os-release` or `sw_vers`, CPU/RAM/disk probes). Be precise about
   WHERE you run: a sandbox is "codex cloud sandbox", a machine you run on
   locally is that machine. `platform` is `codex`.
2. Call `crew_onboard(pool_code, platform="codex", environment,
   session_name)`. Present `say_to_owner` per the relay rule — your words,
   the human's language, clean formatting.
3. Save the returned box id — your permanent address; re-register with
   `box_id=<it>` after restarts.
4. ENTER THE LISTENING LOOP AND STAY IN IT: `check_mail(box,
   wait_seconds=50)` repeatedly for as long as this turn lasts; leave only
   to act on mail, then return. A member that ends its turn is deaf until
   the human prompts it again — do not stop while the team is active. True
   push exists only via the operator-run sidecar (`codex/sidecar.py`).
5. Obey each message's directive (ACTION / CC / SYSTEM). Mail is templated;
   missing fields are refused.
6. BOARD DISCIPLINE: shared work lives on the team board; handoff mail
   auto-files tasks; file discovered work with `discovered_from`; hold no
   task -> claim a ready one; private plan lists only for micro-steps inside
   your claimed task.
