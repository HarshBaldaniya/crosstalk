# Contributing to Crosstalk

Thanks for helping. Issues and pull requests are welcome.

## Set up

```bash
git clone https://github.com/HarshBaldaniya/crosstalk.git
cd crosstalk
npm install
npm run build              # builds dist/
npm run install:vscode     # builds, packages and installs into your VS Code
```

Reload VS Code after installing. To debug, open the folder in VS Code and run **Run Crosstalk**
(F5): a second window opens with the extension loaded from source.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Tests never touch your real `~/.crosstalk`, `~/.claude`, `~/.codex` or `~/.gemini`: they point every
path at a temporary folder. Keep it that way in new tests. A few tests read real Claude Code chats
when `CROSSTALK_TEST_DIR` names a folder that has some; otherwise they are skipped.

## How the code is laid out

| Folder | What lives there |
|---|---|
| `src/adapters/` | Reading each agent's own session files (Claude Code, Codex, Gemini CLI) |
| `src/core/` | Flightlogs, channels and inboxes, plan limits, tokens, the agents' toolkit |
| `src/hook/` | The small script agents run after each reply |
| `src/codemap/` | The Map: parsing, imports, search, modules |
| `src/mcp/` | The three tools agents call |
| `src/library/` | The commands (`content/*.md` is each command's text) |
| `src/vscode/` | The extension: the sidebar, the board pages and the services |
| `webview-ui/` | The pages (React): Tower, Fuel, Map, Commands, the sidebar |

## Releasing

One version lives in `package.json`, `.claude-plugin/plugin.json` and `gemini-extension.json`.

```bash
npm run set-version -- 0.0.2   # sets it in all three and re-pins crosstalk-ai@0.0.2
npm test
npm run publish:npm             # publishes crosstalk-ai, then create-crosstalk (npm create crosstalk)
git commit -am "0.0.2" && git tag v0.0.2 && git push --follow-tags
```

Publish to npm before pushing the tag: the plugin and the Gemini extension start the tools through
`bin/mcp.cjs`, which fetches `crosstalk-ai@<version>` when it isn't on the computer yet, so that
version has to exist. `create-crosstalk` depends on the same version, so publish `crosstalk-ai` first. Check the plugin with
`claude plugin validate .`.

## Style

- Plain words in the interface: say what a thing does for the person, not how it works.
- Every page works from a narrow sidebar to a wide screen.
- No new runtime dependency without a reason in the pull request.
- Crosstalk never runs an AI model of its own and never reads a login or a token file.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
