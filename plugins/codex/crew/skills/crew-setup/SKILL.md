---
name: crew-setup
description: Run the crew team setup interview with the owner. Use when the human says "crew setup <code>".
---
1. Call `crew_setup(pool_or_team, my_box)`. If it says you are not in the
   pool, run the crew-onboard skill yourself and call it again — never hand
   the instruction back to the human.
2. It returns ALL remaining questions as ONE batch. Ask the human everything
   in a single message — use your host's structured question/form UI if one
   exists, otherwise one clean numbered message. Present per the relay rule:
   their language, first person where a question is about this session.
   Never answer for them; "default" is always valid.
3. Submit with `setup_answers(code, answers)`. Fix per-item errors, run any
   handoffs it names (crew-ownermail flow, custom mode d), then call
   `setup_questions` again until done.
4. On done: present the team card nicely, remember the team id yourself (the
   human never repeats ids), then enter the `check_mail` listening loop.
