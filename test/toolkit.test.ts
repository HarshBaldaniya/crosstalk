// The Toolkit install: each agent gets Crosstalk's tools and commands; removal takes out only ours.
// Every agent home here is a temporary folder: the real ~/.claude, ~/.codex and ~/.gemini are never read.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentStates, codexConfigPath, codexPrompt, codexPromptsDir, geminiSettingsPath, installToolkit, mcpServerPath, removeToolkit, withoutCodexBlock, type Runner } from "../src/core/toolkit";
import { builtinCommands } from "../src/library/index";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let calls: string[][] = [];
const fakeClaude: Runner = async (cmd, args) => {
  calls.push([cmd, ...args]);
  return { ok: true, out: "" };
};

beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-kit-home-");
  process.env.CODEX_HOME = tmp("crosstalk-kit-codex-");
  process.env.CROSSTALK_GEMINI_HOME = tmp("crosstalk-kit-gemini-");
  process.env.CLAUDE_CONFIG_DIR = tmp("crosstalk-kit-claude-");
  delete process.env.CROSSTALK_CLAUDE_JSON;
  calls = [];
});

test("set up: Claude through its own command, Codex's config.toml and prompt files, Gemini's settings.json, each backed up", async () => {
  fs.writeFileSync(codexConfigPath(), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  fs.writeFileSync(geminiSettingsPath(), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "y" } } }));
  fs.mkdirSync(codexPromptsDir(), { recursive: true });
  fs.writeFileSync(path.join(codexPromptsDir(), "review.md"), "my own review prompt");

  const lines = await installToolkit(["claude", "codex", "gemini"], { node: "/usr/bin/node", claudeCli: "/bin/claude", run: fakeClaude });
  assert.match(lines.join(" "), /Claude Code: tools and 28 commands added/);
  assert.deepEqual(calls[1], ["/bin/claude", "mcp", "add", "crosstalk", "--scope", "user", "--", "/usr/bin/node", mcpServerPath()]);

  const toml = fs.readFileSync(codexConfigPath(), "utf8");
  assert.match(toml, /^model = "gpt-5"\n\n\[mcp_servers\.other\]\ncommand = "x"\n\n\[mcp_servers\.crosstalk\]\ncommand = "\/usr\/bin\/node"\nargs = \[".*crosstalk-mcp\.js"\]\n$/);
  assert.ok(fs.existsSync(`${codexConfigPath()}.crosstalk-backup`));
  assert.equal(fs.readFileSync(path.join(codexPromptsDir(), "review.md"), "utf8"), "my own review prompt", "the person's own prompt is never overwritten");
  assert.ok(fs.existsSync(path.join(codexPromptsDir(), "pr.md")));
  assert.equal(fs.readdirSync(codexPromptsDir()).filter((f) => f.endsWith(".md")).length, 28, "27 of ours plus theirs");

  const gemini = JSON.parse(fs.readFileSync(geminiSettingsPath(), "utf8"));
  assert.equal(gemini.theme, "dark");
  assert.deepEqual(gemini.mcpServers.crosstalk, { command: "/usr/bin/node", args: [mcpServerPath()] });
  assert.deepEqual(gemini.mcpServers.other, { command: "y" });

  // Running it again changes nothing twice.
  await installToolkit(["codex", "gemini"], { node: "/usr/bin/node" });
  assert.equal((fs.readFileSync(codexConfigPath(), "utf8").match(/\[mcp_servers\.crosstalk\]/g) ?? []).length, 1);
});

test("remove: only what Crosstalk added goes; everything else stays as it was", async () => {
  fs.writeFileSync(codexConfigPath(), 'model = "gpt-5"\n');
  fs.writeFileSync(geminiSettingsPath(), JSON.stringify({ theme: "dark" }));
  fs.mkdirSync(codexPromptsDir(), { recursive: true });
  fs.writeFileSync(path.join(codexPromptsDir(), "mine.md"), "keep me");
  await installToolkit(["codex", "gemini"], { node: "node" });
  const states = agentStates();
  assert.deepEqual(states.filter((a) => a.id !== "claude").map((a) => [a.id, a.present, a.tools, a.commands]), [["codex", true, true, 28], ["gemini", true, true, 28]]);

  const lines = await removeToolkit(["claude", "codex", "gemini"], { claudeCli: "/bin/claude", run: fakeClaude });
  assert.match(lines.join(" "), /Codex: tools removed, 28 commands removed\. Gemini CLI: tools removed\./);
  assert.deepEqual(calls.at(-1), ["/bin/claude", "mcp", "remove", "crosstalk", "--scope", "user"]);
  assert.equal(fs.readFileSync(codexConfigPath(), "utf8"), 'model = "gpt-5"\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(geminiSettingsPath(), "utf8")), { theme: "dark", mcpServers: {} });
  assert.deepEqual(fs.readdirSync(codexPromptsDir()), ["mine.md"]);
});

test("Codex's table comes out cleanly, sub-tables too; a Codex prompt takes what's typed as its main argument", () => {
  const toml = 'a = 1\n\n[mcp_servers.crosstalk]\ncommand = "n"\n\n[mcp_servers.crosstalk.env]\nX = "1"\n\n[profiles.fast]\nmodel = "m"\n';
  assert.equal(withoutCodexBlock(toml), 'a = 1\n\n[profiles.fast]\nmodel = "m"\n');
  const review = codexPrompt(builtinCommands().find((c) => c.name === "spec")!);
  assert.match(review, /^---\ndescription: Turn an idea into a spec.*\nargument-hint: What should be built or changed\n---\nWrite a spec for: \$ARGUMENTS\n/);
});

test("an agent's unreadable settings are left alone", async () => {
  fs.writeFileSync(geminiSettingsPath(), "{ not json");
  const lines = await installToolkit(["gemini"], { node: "node" });
  assert.match(lines[0], /couldn't be read, so it was left alone/);
  assert.equal(fs.readFileSync(geminiSettingsPath(), "utf8"), "{ not json");
});
