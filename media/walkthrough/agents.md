# Give your agents the map and commands

**Set up my agents** gives Claude Code, Codex and Gemini CLI three small tools (each agent's settings
are backed up first):

- `crosstalk_map`: find code by name or meaning, see what uses what, outline a file.
- `crosstalk_flightlog`: what another chat asked and did.
- `crosstalk_notes`: notes chats leave for the project.

…and the **Commands**: `/crosstalk:plan`, `/crosstalk:review`, `/crosstalk:pr` and more in Claude Code
(`/prompts:…` in Codex, `/…` in Gemini CLI).

**Remove the toolkit from my agents** undoes it.
