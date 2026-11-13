---
name: update
title: Write an update
pack: product
description: A weekly or stakeholder update written from what your chats actually did, in plain words.
args: period = Time covered (default: the last 7 days); audience = Who reads it (default: the team)
triggers: weekly update, status update, stakeholder update, progress report, what did we do this week, standup, investor update
---
Write an update for {{audience}} covering {{period}}.

1. **Gather facts, don't invent them:** `crosstalk_flightlog` with no chat lists recent chats; read the ones in the period. Use what was asked, done, and still open, plus PRs and commits they name.
2. **Group by outcome, not by chat:** what shipped, what moved forward, what's blocked.
3. **Write it:**
   - **In one line:** the most important thing that happened.
   - **Done:** three to six bullets, each a result someone outside the code would care about.
   - **In progress:** what, and when it's expected.
   - **Blocked or needs a decision:** what, and who can unblock it.
   - **Next:** the top three things.
4. Plain words for the audience: no file names or internal terms unless the readers are engineers.

Keep it under 200 words unless asked for more. Ask before sending it anywhere.
