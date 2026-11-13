---
name: slack
title: Draft a Slack message
pack: connected
needs: slack
description: Draft a Slack post, reply or update that's short and easy to act on; you post it.
args: purpose* = What to say; where = Channel or person (default: where the person says; ask if unclear)
triggers: post in slack, slack message, slack update, reply in thread, announce in slack
---
Draft a Slack message for {{where}}: {{purpose}}.

1. Read the channel or thread first if it's a reply, and the channel's purpose if it's new.
2. **Shape:** the point in the first line; details as two to four bullets; links to PRs or docs; one clear ask with an owner and a date if needed. Mention people only when they need to act.
3. Facts from the session logs, PRs and what the person said; nothing invented.
4. Save it as a draft (or show it) and let the person post it. Never post on your own.
