---
name: cleanup
title: Clean up
pack: workflow
description: Find unused code, docs that name things that are gone, and finished change folders; remove only what you confirm.
args: area = Folder to focus on (default: the whole codebase)
triggers: clean up, cleanup, dead code, unused code, remove unused, stale docs, tidy the repo, garbage collect
---
Clean up {{area}}.

1. **Gather, by code:** `crosstalk_map` with check "unused" (files nothing imports, exports nothing uses, exports used only in their own file) and with check "docs" (doc lines naming files, hooks or scripts that are gone). List `changes/*/` folders whose tasks are all ticked.
2. **Verify each candidate** before proposing it: grep its name once more (dynamic imports, string lookups, framework conventions such as route files, config and plugin names).
3. **Group them:** safe to delete · export can go (used only in its own file) · doc lines to fix · change folders to archive (move to `changes/archive/`) · keep (with the reason).
4. **Ask before each group.** Make the changes for the confirmed groups only, then run the tests and type checks and report the result.
