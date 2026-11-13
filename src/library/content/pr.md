---
name: pr
title: Open a pull request
pack: engineering
description: Write a pull request's title and body from what was actually asked and done, then open it when you say so.
args: base = Branch to merge into (default: the repo's default branch); ticket = Ticket id to link (default: none)
triggers: open a pr, create pr, make a pull request, raise a pr, ship this, push and open pr
---
Prepare a pull request into {{base}}. Ticket: {{ticket}}.

1. **Check first:** `git status`; nothing unrelated staged (lockfiles, local config, generated folders). Run the project's tests and type checks if they're quick; report what you ran.
2. **Know what happened:** `crosstalk_flightlog` (this chat) gives what was asked and done; the diff says the rest. Don't claim anything the diff doesn't show.
3. **Title:** under 70 characters, imperative, what changes for a user or a developer ("Show upload progress per file").
4. **Body:**
   - **What:** two or three sentences.
   - **Why:** the problem, linked to the ticket if there is one.
   - **How to test:** numbered steps a reviewer can follow, with expected results.
   - **Risk and rollout:** migrations, flags, deploy order, or "none".
   - **Not in this PR:** anything deliberately left out.
5. Show the title and body, then ask before pushing or opening anything. On yes: push the branch and open it with `gh pr create`.
