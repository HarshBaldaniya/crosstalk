---
name: module-docs
title: Draft module docs
pack: workflow
description: Draft a short doc for one part of the code (what code can't say), for the person to approve before agents use it.
args: module* = The module, as the code map names it (e.g. features/upload)
triggers: module docs, document this module, write docs for this part, explain this module, architecture notes, onboarding notes
---
Draft the doc for {{module}}.

1. **Read it through the map:** `crosstalk_map` with outline "{{module}}" (its files, what it uses, its conventions), then graph on its two or three most used symbols. Open only the files that hold the answers.
2. **Write only what code can't say,** at most 40 lines, in these sections:
   - **What it's for:** two sentences.
   - **How it works:** the main flow, naming real functions and files in backticks.
   - **Rules:** what not to do here, and why (a race, a contract with another part, a cost).
   - **How to test it:** the command, and the test files that matter.
   - **Watch out:** traps a newcomer would hit.
   No lists of every file or function; the map already has those.
3. **Save it** to `docs/modules/<module with / as ->.md` starting with:
   ```
   ---
   module: {{module}}
   status: draft
   ---
   ```
   Never mark it approved, and never overwrite a doc whose status is approved; ask first.
4. Tell the person: review it, then approve it with "Crosstalk: Module docs" in VS Code. Agents read only approved docs.
