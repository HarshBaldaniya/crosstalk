---
name: handoff
title: Hand off to a fresh chat
pack: sessions
description: Leave a short note so a fresh chat (any agent) continues this work without re-reading this conversation.
args: next = What the next chat should do first (default: the most important open item)
triggers: hand off, handoff, handover, continue in a new chat, start fresh, context is full, wrap up this chat
---
Hand this chat's work over. Next step: {{next}}.

1. Write the note with `crosstalk_notes`, title "<topic>: handoff", in this shape:
   - **Goal:** what this work is for, one or two lines.
   - **Decisions:** what was decided and why, including what was ruled out.
   - **Done:** what's finished, with files and PRs.
   - **Open:** what's unfinished or broken, exactly where.
   - **Next:** the first three steps for the next chat, starting with the next step above.
   - **Watch out:** traps found the hard way (commands, flaky tests, rules).
2. Keep it under 300 words: facts, paths and names, no story.
3. Tell the person: in the new chat, run `/catchup` or ask it to read this note with `crosstalk_notes`.
