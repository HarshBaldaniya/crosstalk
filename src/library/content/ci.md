---
name: ci
title: Fix CI
pack: engineering
description: Find why a CI run or deployment failed from its logs, and fix the cause rather than the symptom.
args: run = Failing run, PR or job (default: the latest failing run on this branch)
triggers: ci failing, fix ci, failing checks, github actions, pipeline failed, build failed, deploy failed, make ci green
---
Fix the failure in {{run}}.

1. **Read the failure first:** `gh run list --branch <branch> --limit 5`, then `gh run view <id> --log-failed`. Find the first real error, not the last line.
2. **Reproduce locally** with the same command the job runs (read the workflow file for it). If it passes locally, compare versions, environment variables, caches and the files CI checks out.
3. **Classify:** our code broke · a test is wrong or flaky (prove which: run it ten times) · environment or dependency changed · the workflow itself.
4. **Fix the cause.** Never skip, retry-until-green, or loosen a check to get past it; if a check is truly wrong, say so and change it in its own commit with the reason.
5. Run the same command again and show it passing. Ask before pushing.

Report: the cause in one line, the fix, and how you verified it.
