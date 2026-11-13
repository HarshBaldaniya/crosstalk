---
name: pr-review
title: Review a pull request
pack: engineering
description: Review someone's pull request on GitHub, or answer the review comments on yours.
args: pr* = PR number or link; mode = review or respond (default: review if it isn't yours, respond if it is)
triggers: review this pr, pr review, review pr #, respond to review comments, answer review, address feedback
---
Pull request: {{pr}} ({{mode}}).

**Fetch:** `gh pr view {{pr}} --json title,author,baseRefName,headRefName,files,statusCheckRollup,reviews,body,url` and `gh pr diff {{pr}}`. Work out whose PR it is with `gh api user --jq .login`.

**Reviewing someone else's PR:** apply the same lens as `/review`: correctness, security, contract, tests, scope, and the ripple sweep. Check the PR body's claims and test steps against the code. Every finding has `path:line` and a concrete failure. Only code bugs block; process steps go under "before merge" so the author doesn't need a second review for them.
Show the verdict and findings in chat first. Post nothing until the person picks: request changes / approve (whichever matches) / comment only / don't post. When posting, put each finding inline on its line (40-120 words: what fails, why, the fix), and a short summary as the review body.

**Responding to comments on your own PR:** list every unresolved comment. For each: agree and fix, or explain briefly why not, with evidence. Make the fixes, run the checks, then draft one reply per comment. Ask before pushing or posting.
