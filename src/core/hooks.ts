// Adds Crosstalk's status hook to Claude Code's user settings (~/.claude/settings.json),
// and takes it out again. Only ever called from the Connect / Disconnect commands,
// which the person runs themselves. Other settings and hooks are left as they are,
// and the file is backed up before the first change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { crosstalkHome, guardRealHome, writeFileAtomic } from "./paths";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionEnd"] as const;
const MARK = "crosstalk-hook.js";
/** Hooks written when Crosstalk was called Relay: still ours, so they are replaced, never doubled. */
const OLD_MARK = "relay-hook.js";
const ours = (command: string | undefined) => !!command && (command.includes(MARK) || command.includes(OLD_MARK));

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

export function claudeSettingsPath(): string {
  if (process.env.CROSSTALK_CLAUDE_SETTINGS) return process.env.CROSSTALK_CLAUDE_SETTINGS;
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

/** Where the hook script is copied, so the command survives extension updates. */
export function installedHookPath(): string {
  return path.join(crosstalkHome(), "crosstalk-hook.js");
}

/**
 * Where a command lives, as the person's own setup finds it: their login shell on macOS and Linux
 * (an editor started from the Dock or a desktop menu has a short PATH), `where` on Windows, then the
 * usual install places.
 */
export function findCommand(name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const tryRun = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  if (platform === "win32") {
    // `where` lists every match; an .exe or .cmd is what can actually be started.
    const found = tryRun("where", [name]).find((p) => /\.(exe|cmd|bat)$/i.test(p) && fs.existsSync(p));
    if (found) return found;
  } else {
    const shells = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter((s): s is string => !!s && fs.existsSync(s));
    for (const shell of shells.slice(0, 2)) {
      const found = tryRun(shell, ["-lc", `command -v ${name}`]).pop();
      if (found && path.isAbsolute(found) && fs.existsSync(found)) return found;
    }
  }
  const home = os.homedir();
  const usual =
    platform === "win32"
      ? [
          path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", `${name}.cmd`),
          path.join(home, ".local", "bin", `${name}.exe`),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", `${name}.exe`),
        ]
      : [path.join(home, ".local", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  return usual.find((p) => fs.existsSync(p));
}

/** The absolute path of `node` (falls back to "node" on the PATH at run time). */
export function findNode(): string {
  // The editor's own Node is not a choice: VS Code ships Electron, not a node the hook can run.
  return findCommand("node") ?? "node";
}

/** The person's own `claude`. */
export function findClaude(): string | undefined {
  return findCommand("claude");
}

export function hookCommand(node: string): string {
  return `"${node}" "${installedHookPath()}"`;
}

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  return text.trim() ? (JSON.parse(text) as Settings) : {};
}

export function isConnected(file = claudeSettingsPath(), events: readonly string[] = HOOK_EVENTS): boolean {
  try {
    const hooks = readSettings(file).hooks ?? {};
    return events.every((e) => (hooks[e] ?? []).some((g) => g.hooks?.some((h) => h.command.includes(MARK))));
  } catch {
    return false;
  }
}

export function connect(command: string, file = claudeSettingsPath(), events: readonly string[] = HOOK_EVENTS, timeout = 5): void {
  const settings = readSettings(file);
  const backup = `${file}.crosstalk-backup`;
  guardRealHome(file);
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const hooks = settings.hooks ?? {};
  for (const event of events) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command)) }));
    const kept = groups.filter((g) => g.hooks.length > 0);
    const entry: HookGroup = { hooks: [{ type: "command", command, timeout }] };
    if (event === "PostToolUse" && file === claudeSettingsPath()) entry.matcher = "*";
    kept.push(entry);
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function disconnect(file = claudeSettingsPath()): void {
  if (!fs.existsSync(file)) return;
  const settings = readSettings(file);
  if (!settings.hooks) return;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}


// ---- every agent Crosstalk can hook into ----

/** One agent's hook settings: where they live, which of its events Crosstalk uses, and its timeout unit. */
export interface HookTarget {
  tool: "Claude" | "Codex" | "Gemini";
  file: string;
  events: readonly string[];
  timeout: number;
  /** The agent is installed (it has a home folder). */
  present(): boolean;
  /** Extra step the agent asks for before new hooks run. */
  note?: string;
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function geminiHome(): string {
  return process.env.CROSSTALK_GEMINI_HOME || path.join(os.homedir(), ".gemini");
}

export function hookTargets(): HookTarget[] {
  return [
    { tool: "Claude", file: claudeSettingsPath(), events: HOOK_EVENTS, timeout: 5, present: () => true },
    {
      tool: "Codex",
      file: path.join(codexHome(), "hooks.json"),
      // Codex's hooks match Claude Code's; PermissionRequest is its "needs you".
      events: ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"],
      timeout: 5,
      present: () => fs.existsSync(codexHome()),
      note: "Codex runs new hooks only once you trust them: type /hooks in Codex and trust Crosstalk's.",
    },
    {
      tool: "Gemini",
      file: path.join(geminiHome(), "settings.json"),
      // Gemini CLI's names: BeforeAgent = a prompt arrives, AfterAgent = a reply ended. Timeouts are in ms.
      events: ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool", "Notification", "SessionEnd"],
      timeout: 5000,
      // ~/.gemini alone is not enough: Antigravity makes it too. Gemini CLI leaves these behind.
      present: () => ["settings.json", "tmp", "projects.json", "oauth_creds.json"].some((n) => fs.existsSync(path.join(geminiHome(), n))),
    },
  ];
}

/** The hook command for one agent: the script, told which agent is calling it. */
export function hookCommandFor(node: string, tool: HookTarget["tool"]): string {
  // `|| true`: should node or the script ever go missing (an nvm version removed, ~/.crosstalk
  // deleted), the hook still ends cleanly. Gemini CLI treats a failed BeforeAgent hook as
  // "block" and would refuse every message.
  return `"${node}" "${installedHookPath()}" ${tool.toLowerCase()}${process.platform === "win32" ? "" : " || true"}`;
}

/** Crosstalk's command in a settings file, if there is one. */
function ourCommand(file: string): string | undefined {
  try {
    for (const groups of Object.values(readSettings(file).hooks ?? {}))
      for (const g of groups) for (const h of g.hooks ?? []) if (ours(h.command)) return h.command;
  } catch {
    // Unreadable: nothing to repair.
  }
  return undefined;
}

/** Agents whose Crosstalk hook names a node that is gone, or was written before the clean ending. */
export function staleHookTargets(): HookTarget[] {
  return hookTargets().filter((t) => {
    if (!t.present()) return false;
    const cmd = ourCommand(t.file);
    if (!cmd) return false;
    const node = /^"([^"]+)"/.exec(cmd)?.[1];
    const gone = !!node && node !== "node" && !fs.existsSync(node);
    return gone || !cmd.includes(MARK) || (process.platform !== "win32" && !cmd.endsWith("|| true"));
  });
}

export function isToolConnected(t: HookTarget): boolean {
  return t.present() && isConnected(t.file, t.events);
}
