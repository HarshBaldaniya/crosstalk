// `crosstalk setup | doctor | remove` and the skills. Every agent home is a temporary folder, and
// Claude Code's own command is never run (claudeCli: null): the real agents are never touched.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudePluginInstalled, doctor, installedVersion, newer, remove, setup, VERSION } from "../src/core/setup";
import { installSkills, removeSkills, SKILLS, skillsDir, skillsState } from "../src/core/skills";
import { agentStates } from "../src/core/toolkit";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let dist = "";

beforeEach(() => {
  const home = tmp("crosstalk-setup-");
  process.env.CROSSTALK_HOME = path.join(home, ".crosstalk");
  process.env.CODEX_HOME = path.join(home, ".codex");
  process.env.CROSSTALK_GEMINI_HOME = path.join(home, ".gemini");
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.CROSSTALK_CLAUDE_JSON = path.join(home, ".claude.json");
  process.env.CROSSTALK_CLAUDE_SETTINGS = path.join(home, ".claude", "settings.json");
  process.env.CROSSTALK_CLAUDE_SKILLS = path.join(home, ".claude", "skills");
  process.env.CROSSTALK_AGENTS_SKILLS = path.join(home, ".agents", "skills");
  for (const d of [".claude", ".codex", ".gemini"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), "{}");
  // A stand-in for the built files setup copies into ~/.crosstalk.
  dist = tmp("crosstalk-dist-");
  for (const f of ["crosstalk-mcp.js", "crosstalk-hook.js", "crosstalk.js"]) fs.writeFileSync(path.join(dist, f), "// built");
  fs.mkdirSync(path.join(dist, "wasm"));
  fs.writeFileSync(path.join(dist, "wasm", "tree-sitter.wasm"), "");
});

test("setup: every agent found gets tools, skills and auto-sharing; doctor then finds nothing to fix", async () => {
  const r = await setup({ fromDir: dist, claudeCli: null });
  assert.deepEqual(r.agents.sort(), ["claude", "codex", "gemini"]);
  assert.ok(r.codexTrust, "Codex is told to trust the new hook");
  assert.equal(installedVersion(), VERSION);
  assert.ok(agentStates().every((a) => a.tools), "every agent has the tools");
  assert.deepEqual(skillsState("claude"), { installed: SKILLS.length, current: SKILLS.length });
  assert.deepEqual(skillsState("codex"), { installed: SKILLS.length, current: SKILLS.length });
  const checks = doctor();
  assert.deepEqual(checks.filter((c) => c.ok !== true), [], JSON.stringify(checks.filter((c) => c.ok !== true)));
});

test("setup twice changes nothing more; remove takes out every entry but keeps the data", async () => {
  await setup({ fromDir: dist, claudeCli: null });
  const claudeJson = fs.readFileSync(process.env.CROSSTALK_CLAUDE_JSON!, "utf8");
  await setup({ fromDir: dist, claudeCli: null });
  assert.equal(fs.readFileSync(process.env.CROSSTALK_CLAUDE_JSON!, "utf8"), claudeJson);
  await remove({ claudeCli: null });
  assert.ok(agentStates().every((a) => !a.tools));
  assert.equal(skillsState("claude").installed, 0);
  assert.ok(fs.existsSync(path.join(process.env.CROSSTALK_HOME!, "version.json")), "data stays without --purge");
  await remove({ purge: true, claudeCli: null });
  assert.ok(!fs.existsSync(process.env.CROSSTALK_HOME!));
});

test("--agents limits setup; --no-sharing leaves hooks off, and doctor says how to turn them on", async () => {
  await setup({ fromDir: dist, claudeCli: null, agents: ["codex"], sharing: false });
  const states = Object.fromEntries(agentStates().map((a) => [a.id, a.tools]));
  assert.deepEqual(states, { claude: false, codex: true, gemini: false });
  const off = doctor().find((c) => c.what === "Codex: auto-sharing off");
  assert.ok(off && off.ok === "warn" && /crosstalk setup --agents codex/.test(off.fix ?? ""));
});

test("skills never replace a person's own skill of the same name, and refresh when Crosstalk's text changes", () => {
  const own = path.join(skillsDir("claude"), "crosstalk-recall");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "SKILL.md"), "my own");
  installSkills(["claude"]);
  assert.equal(fs.readFileSync(path.join(own, "SKILL.md"), "utf8"), "my own");
  assert.equal(skillsState("claude").installed, SKILLS.length - 1);
  // An older Crosstalk's text counts as not current.
  fs.writeFileSync(path.join(skillsDir("claude"), "crosstalk-find-code", "SKILL.md"), "old");
  assert.equal(skillsState("claude").current, SKILLS.length - 2);
  removeSkills(["claude"]);
  assert.ok(fs.existsSync(own), "the person's own skill stays");
});

test("every skill has a name matching its folder and a description that says when to use it", () => {
  for (const s of SKILLS) {
    const front = /^---\n([\s\S]*?)\n---/.exec(s.text)?.[1] ?? "";
    assert.match(front, new RegExp(`^name: ${s.name}$`, "m"));
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    assert.match(description, /Use when/);
    assert.ok(description.length < 400, `${s.name}: keep the description short (${description.length})`);
  }
});

test("with the Claude Code plugin installed, setup leaves Claude's tools and skills to the plugin", async () => {
  const plugins = path.join(process.env.CLAUDE_CONFIG_DIR!, "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "crosstalk@crosstalk": [{ scope: "user" }] } }));
  assert.ok(claudePluginInstalled());
  await setup({ fromDir: dist, claudeCli: null });
  assert.equal(agentStates().find((a) => a.id === "claude")!.tools, false);
  assert.equal(skillsState("claude").installed, 0);
  assert.equal(skillsState("codex").installed, SKILLS.length);
  assert.ok(doctor().some((c) => c.ok === true && /from the Crosstalk plugin/.test(c.what)));
});

test("versions compare as numbers", () => {
  assert.ok(newer("0.0.10", "0.0.9"));
  assert.ok(newer("1.0.0", "0.9.9"));
  assert.ok(!newer("0.1.0", "0.1.0"));
  assert.ok(!newer("0.0.1", "0.0.2"));
});
