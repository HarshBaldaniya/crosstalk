---
name: plan
title: Plan a change
pack: workflow
description: Plan a change as a folder you approve before any code: why, acceptance lines, and tasks in dependency order.
args: goal* = What the change should achieve; slug = Short folder name (default: made from the goal)
triggers: plan this, make a plan, plan the change, break this down, change folder, tasks for, before we build
---
Plan: {{goal}}. Folder: `changes/{{slug}}/`.

1. **Clarify** in at most three short questions if who it's for, what done means, or a hard limit is unclear. Otherwise go on.
2. **Ground it:** `crosstalk_map` overview, then find and outline for every area the goal touches; graph on anything you'd change, to see what else depends on it. Name only real paths.
3. **Write `changes/{{slug}}/proposal.md`:**
   - **Why** (two sentences) and **What changes** (behaviour, then code areas).
   - **Acceptance lines**, numbered, each testable: "When <situation>, the system shall <result>."
   - **Out of scope**, and **Risks** with how each is handled.
4. **Write `changes/{{slug}}/tasks.md`:** one line per task as `- [ ] 3. <what> · files: <paths> · after: 1, 2 · check: <command or test that proves it>`. Small tasks (one concern each); tasks with no `after` between them can run in parallel.
5. **Stop and ask for approval.** Show the acceptance lines and the task list. Nothing is built until the person says go; then `/build {{slug}}`.

For a change under an hour, skip the folder: a paragraph, the acceptance lines and the steps, in chat.
