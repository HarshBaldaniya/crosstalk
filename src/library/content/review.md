---
name: review
title: Review a change
pack: engineering
description: Review a change for real bugs, security holes and missing tests, against what it was meant to do.
args: changes = Branch, diff or PR (default: this branch against its base, plus uncommitted work); goal = What the change should do (default: what the session log or PR body says)
triggers: review my code, code review, review my changes, self review, check my diff, before pr, is this correct, review this
---
Review {{changes}}. It should: {{goal}}.

**Read:** the whole diff, untracked files too. Open surrounding code only where a finding depends on it; `crosstalk_map` with graph shows who calls what changed.

**Look for, in order:**
1. Correctness: edge cases, error paths, races, retries and replays.
2. Security: who may do this, input checks, secrets, tenant or user isolation.
3. Contract: API shape, backward compatibility, deploy order between parts.
4. Tests: is the risky path covered? Name the missing case.
5. Scope: unrelated files that belong in another change.

**Ripple sweep (always):** for every name the diff removes or renames, search for leftovers (stories, mocks, docs, comments). For every deleted caller, check what it used still has a caller. Re-read comments next to changed lines; one that now contradicts the code is a finding.

**Rules:** every finding has `path:line` and a concrete way it fails ("a user who X sees Y"). No failure scenario, no finding. Only a code bug blocks; process steps (regenerate files, merge order, a manual check) go in "before merge".

**Answer in this shape:**
| | |
|---|---|
| Verdict | ✅ Ready · 🛠️ Fix first (n must-fix) |
| Risk | Low / Medium / High, one reason |
| Scope | files, +added / −removed |

**What it does:** two sentences.

| # | Tag | Where | Finding |
|---|---|---|---|
| 1 | 🔴 Blocker / 🟠 Must fix / 🔵 Before merge / 🟡 Nit | `path:line` | one sentence |

At most six findings. Then offer: fix them, or go ahead.
