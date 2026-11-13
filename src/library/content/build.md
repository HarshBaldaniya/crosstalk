---
name: build
title: Build a planned change
pack: workflow
description: Work through an approved plan's tasks in dependency order, checking each one before ticking it off.
args: slug* = The change folder under changes/
triggers: build the plan, execute the plan, start building, implement the tasks, continue the build, carry on with the plan
---
Build `changes/{{slug}}/`.

1. **Read** `proposal.md` and `tasks.md`. If the proposal isn't marked approved by the person in this chat or the file, ask first.
2. **Order:** tasks whose `after` tasks are all ticked are ready. Ready tasks with no shared files can run at the same time (use subagents if you have them, one task each, with the task line and its files as their whole brief).
3. **Each task:** find its code with `crosstalk_map` (find, outline), make the change, then run its `check`. Tick it (`- [x]`) only when the check passes. Touch only the files the task names; if another file must change, say so and add it to the task line.
4. **When a check fails:** fix it within the task; after two failed attempts, stop and report what fails and why, rather than working around it.
5. **At the end:** run the project's full tests and type checks, list what changed per task, and suggest `/audit {{slug}}`.

Never commit or push unless the person asks.
