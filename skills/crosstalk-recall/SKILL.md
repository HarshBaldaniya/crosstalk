---
name: crosstalk-recall
description: Find what an earlier AI chat did about something, in Claude Code, Codex or Gemini CLI, by words, a file or a code name. Use when the person asks what was done before, which chat changed something, or whether this was already tried.
---

# Recall past work

1. `crosstalk_flightlog` with `query: "<what the person asked about>"` searches every chat on this
   computer, all three agents, by words and by code names (a function's name also finds the chats
   that changed its file).
2. Read the two or three best matches in full: `chat` and `n` for one ask.
3. **Answer** with what was done, in which chat and when, the files and pull requests, and what was
   left open. If the trail ends, say where.
