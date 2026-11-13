---
name: security
title: Security check
pack: engineering
description: Find what an attacker could do with this code: threats, real findings and fixes, ranked.
args: target = Area, feature or change to check (default: this branch's changes); depth = quick or full (default: quick)
triggers: security audit, security review, threat model, is this secure, hardening, vulnerability, pentest
---
Security check of {{target}} ({{depth}}).

1. **Map the surface:** entry points (routes, handlers, jobs, webhooks, file uploads), what each trusts, and where secrets live. `crosstalk_map` with find "route" lists web routes.
2. **Ask of each entry point:**
   - Who may call it, and is that checked on the server every time?
   - Can one user reach another's data (ids in URLs, missing owner checks)?
   - Is every input validated: size, type, path, SQL, HTML, shell, redirects, SSRF?
   - Are secrets kept out of logs, URLs, the client bundle and error messages?
   - Can it be abused at volume (no rate limit, expensive work per call)?
   - Do dependencies with known holes sit on this path?
3. **Findings only with evidence:** `path:line`, the attack in one sentence ("a signed-in user can read any invoice by changing the id"), its impact, and the fix. A suspicion without a path is a question, listed separately.
4. **Rank:** Critical (data loss, account takeover, money) → High → Medium → Low.

Answer with the table of findings, then the three fixes worth doing first. Ask before changing code.
