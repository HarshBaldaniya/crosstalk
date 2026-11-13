---
name: recall
title: Recall past work
pack: sessions
description: Find what any past chat did about something: by words, file or code name, across every agent.
args: topic* = What to look for
triggers: recall, what did we do about, which chat, have we done this before, find the chat where, remember when, past work
---
Find past work on: {{topic}}.

1. `crosstalk_flightlog` with query "{{topic}}" searches every chat's asks on this computer, Claude, Codex and Gemini alike, by words and by code names (a function's name also finds the chats that changed its file).
2. Read the two or three best matches in full with chat and n.
3. **Answer:** what was done, in which chat and when, which files and PRs, and what was left open. If the trail ends, say where.
