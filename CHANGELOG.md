# Changelog

## 0.0.2

- `npm create crosstalk` now adds the `crosstalk` command. It used to mistake the temporary copy
  that `npm create` (and npx, pnpm dlx, yarn dlx, bunx) puts on the PATH for an installed one, skip
  the install, and then point to a `crosstalk` command that wasn't there.

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
- **One command**: `npm create crosstalk` sets up every agent found and adds the `crosstalk`
  command. Then `crosstalk` shows what each agent has, `crosstalk doctor` checks it, `crosstalk
  update` moves to the newest version and `crosstalk remove` takes it out. `npx crosstalk-ai` does
  the same without installing. The same on macOS, Windows and Linux, with npm, pnpm, Yarn or Bun.
- **A full command line**: grouped help, `crosstalk help <command>` with examples, `version`,
  `about`, `docs`, `bug` (an issue with your version and system filled in), `--json` for scripts,
  tab completion for bash, zsh, fish and PowerShell, and "did you mean" for typos.
- **Used without being asked**: the tools carry instructions agents read at the start of a session,
  and three skills (`crosstalk-find-code`, `crosstalk-recall`, `crosstalk-catchup`) load when a task
  matches.
- **Claude Code plugin** and **Gemini CLI extension**, both installed from this repository and kept
  current by the agent itself.
