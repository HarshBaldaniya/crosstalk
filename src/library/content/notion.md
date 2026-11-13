---
name: notion
title: Project page in Notion
pack: connected
needs: notion
description: Write a project page in Notion from the code map and session logs: what it is, how it works, how to run it.
args: project = Which project (default: this folder); page = Existing page to update (default: none; make a new page)
triggers: notion docs, project wiki, document this project in notion, notion page
---
Write a Notion page for {{project}}. Existing page: {{page}}.

1. **Facts from the code:** `crosstalk_map` overview for stack, commands, entry points and main folders; outline for the important areas. Recent decisions from `crosstalk_flightlog`.
2. **Sections:** What it is (two sentences) · How it works (main parts and how they connect) · Run it locally (exact commands) · Where things are (a table of folders and what lives there) · Recent changes · Open questions.
3. Keep every name and command exactly as in the code.
4. Show the outline first; create or update the page only when the person agrees, and mark it private unless they say otherwise.
