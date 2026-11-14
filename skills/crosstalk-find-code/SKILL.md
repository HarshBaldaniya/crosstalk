---
name: crosstalk-find-code
description: Find code in this project fast, before searching or opening files. Use when you need where something is defined, what calls or imports it, or how a folder is laid out. Answers in a few hundred tokens from Crosstalk's map of the code.
---

# Find code with the Crosstalk map

Ask the map first. Use grep or read whole files only when the map has nothing.

1. **Where is it?** `crosstalk_map` with `find: "<a name or plain words>"`. You get ranked matches as
   `path:start-end`; read only those lines.
2. **What's in this file or folder?** `crosstalk_map` with `outline: "<path or name>"`: one level, with
   line ranges.
3. **What uses it, and what does it use?** `crosstalk_map` with `graph: "<name or path>"`; add
   `hops: 2` for one more step.
4. **New to the project?** `crosstalk_map` with no arguments: the commands, entry points and main parts.

Without the tool (another agent, a terminal, CI), the same answers come from the command line:
`node ~/.crosstalk/crosstalk.js find "<words>"`, and `outline`, `graph`, `overview`.

The map is built by a parser on this computer and stays fresh as files are saved. It covers
TypeScript, JavaScript, Python, Go, Rust, Java, C#, Ruby and PHP.
