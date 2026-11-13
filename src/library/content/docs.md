---
name: docs
title: Write developer docs
pack: engineering
description: Write or update a README, API reference or guide that matches the code as it is today.
args: topic* = What to document; audience = Who reads it (default: a developer new to this code)
triggers: write documentation, readme, api docs, document this, developer guide, update the docs, runbook
---
Document {{topic}} for {{audience}}.

1. **Read the code, not old docs.** `crosstalk_map` (overview, outline, find) gives the real names, paths, commands and routes. Every name you write must exist in the code today.
2. **Shape it for the reader's first question:** what it is, how to run or call it, then details. Put a working example near the top.
3. **For an API:** each endpoint or function with its inputs, output, errors and one example request and response, taken from the code or tests.
4. **For a runbook:** symptoms → checks (exact commands) → fixes → how to confirm it's fixed.
5. **Keep it short:** one fact once, tables for lists of fields or options, no history of how it got here.

Before saving, re-check every path, command and name you used against the code. Show what changed in the existing doc, if any.
