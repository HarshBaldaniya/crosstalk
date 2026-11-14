# Changelog

## 0.0.1 (first public version)

- **Tower**: every Claude Code, Codex and Gemini CLI chat as a card; connect chats so one gets the
  other's updates with its next message (Ping, Brief or Full).
- **Flightlog**: a short record of each chat (asks, what was done, files, commits, PRs).
- **Fuel**: plan limits as each agent reports them, and tokens per chat.
- **Map**: a board of your project's parts and files, built by a parser on your computer (TypeScript,
  JavaScript, Python, Go, Rust, Java, C#, Ruby, PHP). Agents query it through `crosstalk_map`.
- **Commands**: ready-made commands for all three agents (plan, build, review, pr, tests and more),
  plus your own in `~/.crosstalk/library/`.
- **Agent tools**: `crosstalk_map`, `crosstalk_flightlog` and `crosstalk_notes` over MCP.
- A command-line tool, `~/.crosstalk/crosstalk.js`, for terminals and CI.
- A getting-started walkthrough on VS Code's welcome page.
- **One-command install**: `npx crosstalk-ai setup` sets up every agent found. `crosstalk doctor`
  checks it, `crosstalk update` moves to the newest version, `crosstalk remove` takes it out.
- **Used without being asked**: the tools carry instructions agents read at the start of a session,
  and three skills (`crosstalk-find-code`, `crosstalk-recall`, `crosstalk-catchup`) load when a task
  matches.
- **Claude Code plugin** and **Gemini CLI extension**, both installed from this repository and kept
  current by the agent itself.
