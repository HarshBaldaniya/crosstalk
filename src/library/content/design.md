---
name: design
title: Design decision
pack: engineering
description: Think through a technical decision (system, API or data model) and record it as a short decision record.
args: question* = The decision to make; constraints = Limits to respect: scale, budget, deadline, systems that can't change (default: none given; find them in the code and ask about any that matter)
triggers: system design, api design, data model, architecture, how should we structure, technical decision, adr, schema design
---
Decide: {{question}}. Constraints: {{constraints}}.

1. **Today's shape:** read the current code first (`crosstalk_map` overview, then outline and graph on the areas involved). Name what exists and what depends on it.
2. **Options:** two or three real ones, including "change as little as possible". For each: how it works in three lines, what it costs (build time, running cost, complexity), how it fails, and how it's undone.
3. **For an API:** resources and operations, request and response shapes, errors, auth, versioning, pagination. **For data:** entities, keys, relations, indexes for the real queries, and the migration from today's data, safe to run twice.
4. **Recommend one,** with the reason that decides it.

Write the decision record (to `docs/decisions/<date>-<slug>.md` if the person agrees):
- **Context:** the problem and constraints.
- **Decision:** what we'll do.
- **Why:** the deciding reason; the options rejected and why.
- **Consequences:** what gets easier, harder, and what to watch.
