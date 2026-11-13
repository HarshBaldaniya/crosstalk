---
name: user-docs
title: Write a help article
pack: product
description: Write a help article or how-to that a customer can follow, step by step, in plain words.
args: task* = What the customer wants to do; product = Where it's done (default: this app)
triggers: user documentation, help article, how to guide, faq, support article, customer docs, explain to users
---
Write a help article: how to {{task}} in {{product}}.

1. **Check the real product:** the screens, button names and limits as they are in the code today (`crosstalk_map` find the page or component). Never describe a feature that isn't there or is switched off.
2. **Title:** the task in the customer's words ("Change your plan").
3. **Before you start:** what they need (an account, a role, a file) in one or two lines.
4. **Steps:** numbered, one action each, using the exact names on screen in **bold**. Say what they'll see after the important steps.
5. **If something goes wrong:** the two or three most likely problems, each with its fix.
6. Short sentences. No internal names, no code, no "simply" or "just".
