---
name: audit
title: Audit a change
pack: workflow
description: Prove each acceptance line of a change with evidence, then review the code from several angles that challenge each other.
args: slug = The change folder under changes/ (default: this branch's changes, with the goal from the session log)
triggers: audit this, audit the change, verify the plan, check the acceptance criteria, adversarial review, is it really done
---
Audit {{slug}}.

1. **Acceptance lines first.** For each line in `changes/{{slug}}/proposal.md` (or the goal, without a folder): find the evidence, a test that proves it (run it) or the `path:line` that does it. Mark each **proven**, **broken** (with how it fails) or **unproven** (no test, and reading the code isn't enough).
2. **Three reviews, then a challenge round.** Review the diff as three separate reviewers: correctness (edge cases, errors, races), security (access, input, secrets), and tests (what's untested that could break). Use subagents in parallel if you have them. Then each reviewer reads the others' findings and either confirms with evidence or rejects with a reason. At most three rounds; keep only findings that survived, with `path:line` and a concrete failure.
3. **Ripple:** `crosstalk_map` with graph on every changed symbol: callers that weren't updated are findings.
4. **Report** in chat, and to `changes/{{slug}}/audit.md` if the folder exists: verdict (ready / fix first), the acceptance table, findings ranked (🔴 blocker, 🟠 must fix, 🔵 before merge, 🟡 nit), and any disagreement left open.
