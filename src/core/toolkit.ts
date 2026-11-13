// The Toolkit install: gives each agent Crosstalk's tools (code map, flightlogs, notes) and the
// Library's commands. Claude Code and Gemini CLI get the commands through MCP (as slash commands);
// Codex gets them as its own prompt files. Every file touched is backed up first, and removal takes
// out only what Crosstalk added.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crosstalkFile, writeFileAtomic } from "./paths";
import { builtinCommands, renderCommand, type LibraryCommand } from "../library/index";

export type AgentId = "claude" | "codex" | "gemini";

export interface AgentState {
  id: AgentId;
  name: string;
  /** The agent is installed on this computer (its home folder exists) */
  present: boolean;
  /** Crosstalk's MCP server is registered with it */
  tools: boolean;
  /** Library commands it has (Codex: prompt files; the others: through MCP) */
  commands: number;
}

const SERVER = "crosstalk";

export const mcpServerPath = () => crosstalkFile("crosstalk-mcp.js");
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const geminiHome = () => process.env.CROSSTALK_GEMINI_HOME || path.join(os.homedir(), ".gemini");
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
/** Where Claude Code keeps user-scope MCP servers. */
export const claudeJsonPath = () =>
  process.env.CROSSTALK_CLAUDE_JSON || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json"));
export const codexConfigPath = () => path.join(codexHome(), "config.toml");
export const codexPromptsDir = () => path.join(codexHome(), "prompts");
export const geminiSettingsPath = () => path.join(geminiHome(), "settings.json");
const MANIFEST = ".crosstalk-manifest";

function backup(file: string) {
  const b = `${file}.crosstalk-backup`;
  if (fs.existsSync(file) && !fs.existsSync(b)) fs.copyFileSync(file, b);
}

function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- what each agent has

export function agentStates(): AgentState[] {
  const claudeServers = readJsonFile<{ mcpServers?: Record<string, unknown> }>(claudeJsonPath())?.mcpServers ?? {};
  const gemini = readJsonFile<{ mcpServers?: Record<string, unknown> }>(geminiSettingsPath())?.mcpServers ?? {};
  let codexToml = "";
  try {
    codexToml = fs.readFileSync(codexConfigPath(), "utf8");
  } catch {
    // No Codex config yet.
  }
  const lib = builtinCommands().length;
  const codexTools = new RegExp(`^\\[mcp_servers\\.${SERVER}\\]`, "m").test(codexToml);
  return [
    { id: "claude", name: "Claude Code", present: fs.existsSync(claudeHome()) || fs.existsSync(claudeJsonPath()), tools: SERVER in claudeServers, commands: SERVER in claudeServers ? lib : 0 },
    { id: "codex", name: "Codex", present: fs.existsSync(codexHome()), tools: codexTools, commands: ownedPrompts().length },
    { id: "gemini", name: "Gemini CLI", present: fs.existsSync(geminiHome()), tools: SERVER in gemini, commands: SERVER in gemini ? lib : 0 },
  ];
}

// ---------------------------------------------------------------- Claude Code

export type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

/** Runs an agent's own command. On Windows a .cmd (as npm installs them) needs a shell to start. */
export const runCli: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const home = os.homedir();
    const extra = process.platform === "win32" ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")] : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
    const quote = (a: string) => (useShell && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    execFile(
      useShell ? quote(cmd) : cmd,
      args.map(quote),
      { timeout: 30_000, windowsHide: true, shell: useShell, env: { ...process.env, PATH: [process.env.PATH ?? "", ...extra].join(path.delimiter) } },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });

async function addToClaude(node: string, claudeCli: string | undefined, run: Runner): Promise<string> {
  if (!claudeCli) return "Claude Code: its command isn't on this computer's PATH; run `claude mcp add crosstalk --scope user -- node ~/.crosstalk/crosstalk-mcp.js` once.";
  // Through Claude's own command: it owns ~/.claude.json and writes it safely while it runs.
  await run(claudeCli, ["mcp", "remove", SERVER, "--scope", "user"]);
  const r = await run(claudeCli, ["mcp", "add", SERVER, "--scope", "user", "--", node, mcpServerPath()]);
  return r.ok ? `Claude Code: tools and ${builtinCommands().length} commands added (as /mcp__crosstalk__review and so on).` : `Claude Code: couldn't add the tools (${r.out.slice(0, 200)}).`;
}

async function removeFromClaude(claudeCli: string | undefined, run: Runner): Promise<string> {
  if (!claudeCli) return "Claude Code: nothing removed (its command isn't on PATH).";
  const r = await run(claudeCli, ["mcp", "remove", SERVER, "--scope", "user"]);
  return r.ok ? "Claude Code: tools removed." : "Claude Code: no Crosstalk tools to remove.";
}

// ---------------------------------------------------------------- Codex

const codexBlock = (node: string) => `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(mcpServerPath())}]\n`;

/** Takes Crosstalk's table out of a config.toml, leaving everything else as it was. */
export function withoutCodexBlock(toml: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) skipping = header[1].trim() === `mcp_servers.${SERVER}` || header[1].trim().startsWith(`mcp_servers.${SERVER}.`);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function addToCodex(node: string): string {
  const file = codexConfigPath();
  let toml = "";
  try {
    toml = fs.readFileSync(file, "utf8");
  } catch {
    // A new config.
  }
  backup(file);
  const base = withoutCodexBlock(toml).replace(/\s*$/, "");
  writeFileAtomic(file, `${base ? `${base}\n\n` : ""}${codexBlock(node)}`);
  const n = writeCodexPrompts(builtinCommands());
  return `Codex: tools added, and ${n} commands as /prompts:review and so on.`;
}

function removeFromCodex(): string {
  const file = codexConfigPath();
  let removedTools = false;
  try {
    const toml = fs.readFileSync(file, "utf8");
    const next = withoutCodexBlock(toml);
    if (next !== toml) {
      backup(file);
      writeFileAtomic(file, next.replace(/\s*$/, "\n"));
      removedTools = true;
    }
  } catch {
    // No config.
  }
  const n = removeCodexPrompts();
  return `Codex: ${removedTools ? "tools removed" : "no tools to remove"}${n ? `, ${n} commands removed` : ""}.`;
}

function ownedPrompts(): string[] {
  try {
    return fs
      .readFileSync(path.join(codexPromptsDir(), MANIFEST), "utf8")
      .split("\n")
      .filter((n) => n && fs.existsSync(path.join(codexPromptsDir(), n)));
  } catch {
    return [];
  }
}

/** A command as a Codex prompt file: what's typed after the command fills its main argument. */
export function codexPrompt(c: LibraryCommand): string {
  const main = c.args.find((a) => a.required) ?? c.args[0];
  const body = renderCommand(c, main ? { [main.name]: "$ARGUMENTS" } : {});
  const head = [`description: ${c.description.replace(/\n/g, " ")}`];
  if (main) head.push(`argument-hint: ${main.description.replace(/\s*\(default:[^)]*\)/i, "").replace(/\n/g, " ")}`);
  return `---\n${head.join("\n")}\n---\n${body}\n`;
}

function writeCodexPrompts(commands: LibraryCommand[]): number {
  const dir = codexPromptsDir();
  fs.mkdirSync(dir, { recursive: true });
  const owned = new Set(ownedPrompts());
  const written: string[] = [];
  for (const c of commands) {
    const file = `${c.name}.md`;
    // Never overwrite a prompt the person made themselves.
    if (fs.existsSync(path.join(dir, file)) && !owned.has(file)) continue;
    writeFileAtomic(path.join(dir, file), codexPrompt(c));
    written.push(file);
  }
  writeFileAtomic(path.join(dir, MANIFEST), `${written.join("\n")}\n`);
  return written.length;
}

/** After an update: Codex's command files follow the Library, if Crosstalk put them there. */
export function refreshCodexPrompts(): number {
  return ownedPrompts().length ? writeCodexPrompts(builtinCommands()) : 0;
}

function removeCodexPrompts(): number {
  const owned = ownedPrompts();
  for (const f of owned) fs.rmSync(path.join(codexPromptsDir(), f), { force: true });
  fs.rmSync(path.join(codexPromptsDir(), MANIFEST), { force: true });
  return owned.length;
}

// ---------------------------------------------------------------- Gemini CLI

function addToGemini(node: string): string {
  const file = geminiSettingsPath();
  const settings = readJsonFile<Record<string, unknown>>(file) ?? {};
  if (fs.existsSync(file) && !readJsonFile(file)) return "Gemini CLI: its settings.json couldn't be read, so it was left alone.";
  backup(file);
  const servers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers[SERVER] = { command: node, args: [mcpServerPath()] };
  settings.mcpServers = servers;
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return `Gemini CLI: tools and ${builtinCommands().length} commands added (as /review and so on).`;
}

function removeFromGemini(): string {
  const file = geminiSettingsPath();
  const settings = readJsonFile<Record<string, unknown>>(file);
  const servers = settings?.mcpServers as Record<string, unknown> | undefined;
  if (!settings || !servers || !(SERVER in servers)) return "Gemini CLI: no tools to remove.";
  backup(file);
  delete servers[SERVER];
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return "Gemini CLI: tools removed.";
}

// ---------------------------------------------------------------- one call

export interface InstallOptions {
  node: string;
  claudeCli?: string;
  run?: Runner;
}

export async function installToolkit(agents: AgentId[], opts: InstallOptions): Promise<string[]> {
  const run = opts.run ?? runCli;
  const out: string[] = [];
  for (const a of agents) {
    try {
      if (a === "claude") out.push(await addToClaude(opts.node, opts.claudeCli, run));
      if (a === "codex") out.push(addToCodex(opts.node));
      if (a === "gemini") out.push(addToGemini(opts.node));
    } catch (err) {
      out.push(`${a}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export async function removeToolkit(agents: AgentId[], opts: Omit<InstallOptions, "node">): Promise<string[]> {
  const run = opts.run ?? runCli;
  const out: string[] = [];
  for (const a of agents) {
    try {
      if (a === "claude") out.push(await removeFromClaude(opts.claudeCli, run));
      if (a === "codex") out.push(removeFromCodex());
      if (a === "gemini") out.push(removeFromGemini());
    } catch (err) {
      out.push(`${a}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
