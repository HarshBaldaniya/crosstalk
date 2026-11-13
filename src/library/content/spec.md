---
name: spec
title: Write a spec
pack: engineering
description: Turn an idea into a spec sized to the change: a paragraph for a small one, a change folder for a big one.
args: idea* = What should be built or changed; size = small or big (default: decide from the idea)
triggers: write a spec, plan this feature, technical spec, design doc, product spec, prd, how should we build
---
Write a spec for: {{idea}}

1. **Clarify first.** If the idea leaves out who it's for, what done looks like, or a hard limit (deadline, budget, a system that can't change), ask at most three short questions and stop. Otherwise go on.
2. **Ground it in the code.** Use `crosstalk_map` (find, then outline) to name the real files, functions and types this touches. Never invent a path.
3. **Size it** ({{size}}). Small (one area, under a day): answer in one paragraph plus acceptance lines. Big: write `changes/<slug>/proposal.md` with the sections below.

Proposal sections, each short:
- **Why:** the problem in two sentences, and who has it.
- **What changes:** user-visible behaviour, then the code areas (real paths).
- **Acceptance lines**, each testable, in the form "When <situation>, the system shall <result>."
- **Out of scope:** what this deliberately leaves alone.
- **Risks:** data, security, migration, rollout order; each with how it's handled.
- **Tasks:** numbered, each one file or one concern, with what it depends on (`after 2`), so independent ones can run in parallel.

End with one line: what you'd build first, and why.
