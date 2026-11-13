---
name: tokens
title: Where my tokens went
pack: sessions
description: See where a chat's tokens went (finding code against doing the work) and what would save the most.
args: chat = Which chat (default: this one)
triggers: tokens, token usage, why so many tokens, context usage, how much context, save tokens, usage of this chat
---
Show where the tokens went in {{chat}}.

1. Call `crosstalk_flightlog` with tokens true (and chat, if one was named).
2. Explain it in plain words: how much went on finding code against doing the work, the biggest reads, anything read again and again, and how full the context is.
3. Give at most three concrete changes, biggest saving first, such as using `crosstalk_map` find instead of searching, outlining a file before reading it, or `/handoff` to a fresh chat when the context is large.
