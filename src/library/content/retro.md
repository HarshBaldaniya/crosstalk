---
name: retro
title: Learn from past sessions
pack: workflow
description: Find the corrections and misses that keep coming back in your chats, and propose a few rule changes you approve.
args: since = How far back to look (default: the last two weeks); rules = The rules file to improve (default: this folder's CLAUDE.md or AGENTS.md)
triggers: retro, retrospective, learn from mistakes, improve the rules, what keeps going wrong, update claude.md, lessons learned
---
Look back over {{since}} and improve {{rules}}.

1. **Evidence:** `crosstalk_flightlog` lists this folder's chats. Search them with query for corrections ("no", "wrong", "again", "instead", "not what I", "revert", "still") and read the matching asks in full with n.
2. **Patterns:** group what went wrong more than once: a rule the agent kept missing, a fact it kept re-discovering, a step it kept skipping. Each pattern needs at least two cited asks (chat and ask number).
3. **Propose at most five changes** to the rules file, each as a small diff. **Merge, don't pile up:** sharpen or replace an existing line before adding a new one; delete rules that no longer match the code. Each change: the evidence, and one sentence on what it prevents.
4. **Check them:** for each change, name an ask from the evidence where it would have made the agent act differently.
5. **Apply only what the person approves.** Show the diff first.
