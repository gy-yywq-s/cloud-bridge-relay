---
description: Join a crew pool with a 4-digit code, then listen
argument-hint: <4-digit pool code>
---
Join the crew team pool `$ARGUMENTS`.

1. GATHER REAL FACTS first — never copy an example. `environment` is
   "where / hardware / OS+version", found by actually looking: `uname -a`,
   `/etc/os-release` or `sw_vers`, CPU/RAM/disk via `sysctl`/`system_profiler`
   or `/proc`. Be precise about WHERE you run: "cloud session" means the
   vendor's hosted cloud product; a session on a server you SSH into is
   "remote session on <host>". `platform` is `claude-code`.
2. Call `crew_onboard(pool_code="$ARGUMENTS", platform, environment,
   session_name)`. Present `say_to_owner` per the relay rule (your words,
   their language, clean formatting).
3. Save the returned box id — your permanent address. If `CREW_BOX` isn't
   exported, give the human the export one-liner for the watcher.
4. ENTER THE LISTENING LOOP AND STAY IN IT: `check_mail(box, wait_seconds=50)`
   repeatedly for as long as this turn lasts. Leave the loop only to act on
   mail, then return. A member that ends its turn is deaf — do not stop while
   the team is active.
