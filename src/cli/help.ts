// Every command, in one table: the help page, `crosstalk help <command>`, "did you mean" and tab
// completion for bash, zsh, fish and PowerShell are all drawn from it, so they never disagree.
import { VERSION } from "../core/setup";
import { DOCS } from "./about";
import { columns, paint } from "./ui";

export type Group = "Get started" | "Find your way in code" | "Chats and commands" | "About";

export interface CommandInfo {
  name: string;
  group: Group;
  args?: string;
  summary: string;
  about?: string;
  options?: [string, string][];
  examples?: string[];
  aliases?: string[];
}

export const COMMANDS: CommandInfo[] = [
  {
    name: "setup",
    group: "Get started",
    summary: "Set up every agent on this computer, or set it up again",
    about: "Finds Claude Code, Codex and Gemini CLI and gives each one the tools, the commands, the skills and auto-sharing, and adds the crosstalk command. Safe to run again: it only replaces its own entries, and backs up every settings file first. Plain `crosstalk` does this when anything is missing.",
    options: [
      ["--agents <list>", "Only these: claude, codex, gemini (comma-separated)"],
      ["--no-sharing", "Leave auto-sharing (the hook) off"],
      ["--no-skills", "Leave out the skills"],
      ["--no-command", "Leave out the crosstalk command"],
      ["--verbose", "List every file it changed"],
    ],
    examples: ["crosstalk setup", "crosstalk setup --agents claude,codex", "crosstalk setup --no-sharing"],
    aliases: ["install", "init"],
  },
  {
    name: "status",
    group: "Get started",
    summary: "What each agent has right now",
    options: [["--json", "As JSON, for scripts"]],
    examples: ["crosstalk status", "crosstalk status --json"],
  },
  {
    name: "doctor",
    group: "Get started",
    summary: "Check that everything works, with the fix for anything that doesn't",
    about: "Checks Node.js, Crosstalk's files, a newer version, and for each agent: the tools, the skills and auto-sharing. Exits with 1 when something needs fixing, so it fits in CI.",
    options: [["--json", "As JSON, for scripts"]],
    examples: ["crosstalk doctor"],
  },
  {
    name: "update",
    group: "Get started",
    summary: "Move to the newest version and refresh every agent",
    about: "Updates the crosstalk command with the package manager that installed it (npm, pnpm, yarn or bun), then refreshes every agent.",
    options: [["--check", "Only say whether a newer version is out"]],
    examples: ["crosstalk update", "crosstalk update --check"],
    aliases: ["upgrade"],
  },
  {
    name: "remove",
    group: "Get started",
    summary: "Take Crosstalk out of every agent",
    about: "Takes out the tools, the skills and the hook. Your flightlogs, map and own commands stay unless you add --purge.",
    options: [["--purge", "Also delete ~/.crosstalk (flightlogs, the map, your own commands)"]],
    examples: ["crosstalk remove", "crosstalk remove --purge"],
    aliases: ["uninstall"],
  },
  {
    name: "find",
    group: "Find your way in code",
    args: "<words>",
    summary: "Where something is: ranked, with path:start-end",
    options: [["--limit <n>", "At most this many results"]],
    examples: ['crosstalk find "rate limiter"', "crosstalk find useAuth --limit 5"],
  },
  { name: "outline", group: "Find your way in code", args: "<path|name>", summary: "A folder, file or symbol, one level, with lines", examples: ["crosstalk outline src/api", "crosstalk outline RateLimiter"] },
  {
    name: "graph",
    group: "Find your way in code",
    args: "<name|path>",
    summary: "Who uses it and what it uses",
    options: [["--hops 2", "One more step out"]],
    examples: ["crosstalk graph RateLimiter", "crosstalk graph src/api/auth.ts --hops 2"],
  },
  { name: "overview", group: "Find your way in code", summary: "The project: commands, entry points, main parts, conventions", examples: ["crosstalk overview"] },
  { name: "map", group: "Find your way in code", args: "[folder]", summary: "Build or refresh the code map (about 1 MB, no AI)", examples: ["crosstalk map", "crosstalk map ../other-project"] },
  {
    name: "check",
    group: "Find your way in code",
    args: "unused|docs",
    summary: "Unused code, or doc lines naming things that are gone",
    about: "`check docs` exits with 1 when a doc names a file, hook or script that no longer exists, so it can fail a CI step.",
    examples: ["crosstalk check unused", "crosstalk check docs"],
  },
  { name: "commands", group: "Chats and commands", args: "[words]", summary: "The ready-made commands, or the ones that fit a task", examples: ["crosstalk commands", 'crosstalk commands "review my branch"'] },
  { name: "tokens", group: "Chats and commands", args: "<chat file>", summary: "Where a Claude Code or Codex chat's tokens went", examples: ["crosstalk tokens ~/.claude/projects/my-app/1234.jsonl"] },
  { name: "backup", group: "Chats and commands", args: "<folder>", summary: "Copy session logs and your commands to a folder", examples: ["crosstalk backup ~/Dropbox/crosstalk"] },
  { name: "restore", group: "Chats and commands", args: "<folder>", summary: "Bring a backup back (merges; never loses anything)", examples: ["crosstalk restore ~/Dropbox/crosstalk"] },
  { name: "mcp", group: "Chats and commands", summary: "Run the MCP server, for an agent's settings", about: "Agents start this themselves. Speaks MCP over stdin and stdout; nothing listens on the network." },
  { name: "version", group: "About", summary: "This version, and whether a newer one is out", options: [["--json", "As JSON, for scripts"]], examples: ["crosstalk version", "crosstalk --version"] },
  { name: "about", group: "About", summary: "Version, system, where it is installed, and the links", options: [["--json", "As JSON, for scripts"]] },
  { name: "docs", group: "About", summary: "Open the guide in your browser" },
  { name: "bug", group: "About", summary: "Report a problem: opens a GitHub issue with your version and system filled in", about: "Nothing is sent until you press Submit on GitHub. No file paths or names are included." },
  {
    name: "completion",
    group: "About",
    args: "<shell>",
    summary: "Tab completion for bash, zsh, fish or PowerShell",
    examples: [
      `echo 'eval "$(crosstalk completion zsh)"' >> ~/.zshrc`,
      `echo 'eval "$(crosstalk completion bash)"' >> ~/.bashrc`,
      "crosstalk completion fish > ~/.config/fish/completions/crosstalk.fish",
      "crosstalk completion powershell | Out-String | Invoke-Expression   # add to $PROFILE",
    ],
  },
  { name: "help", group: "About", args: "[command]", summary: "Help for Crosstalk, or for one command", examples: ["crosstalk help", "crosstalk help find", "crosstalk find --help"] },
];

export const GLOBAL_OPTIONS: [string, string][] = [
  ["--in <folder>", "Work on this folder (default: the one you are in)"],
  ["--json", "Output as JSON (status, doctor, version, about)"],
  ["--no-color", "Plain text, no colour"],
  ["-h, --help", "Help for Crosstalk or a command"],
  ["-v, --version", "The version"],
];

const GROUPS: Group[] = ["Get started", "Find your way in code", "Chats and commands", "About"];

/** Finds a command by its name or one of its aliases. */
export const commandInfo = (name: string) => COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));

/** `self` is how the person types Crosstalk here: `crosstalk`, or `npx crosstalk-ai` before it is installed. */
export function renderHelp(self: string): string {
  const head = (t: string) => paint.bold(t.toUpperCase());
  const parts = [
    `${paint.bold(`Crosstalk ${VERSION}`)}`,
    "A map of your code, your other chats' records and ready-made commands, for Claude Code, Codex and Gemini CLI.",
    "",
    head("Usage"),
    `  ${self} [command] [options]`,
  ];
  // One column width for every group, so the page reads as one table.
  const label = (c: CommandInfo) => `${c.name}${c.args ? ` ${c.args}` : ""}`;
  const w = Math.max(...COMMANDS.map((c) => label(c).length), ...GLOBAL_OPTIONS.map(([a]) => a.length)) + 3;
  parts.push(`  ${self.padEnd(w + 2 - 2)}${paint.dim("Set up every agent, or show what each one has")}`);
  for (const g of GROUPS) parts.push("", head(g), columns(COMMANDS.filter((c) => c.group === g).map((c) => [label(c), c.summary]), 2, 3, w));
  parts.push("", head("Options"), columns(GLOBAL_OPTIONS, 2, 3, w));
  parts.push("", head("Learn more"), `  ${self} help <command>   Options and examples for one command`, columns([["Guide", DOCS], ["Report a problem", `${self} bug`]], 2, 3, w));
  return parts.join("\n");
}

export function renderCommandHelp(c: CommandInfo, self: string): string {
  const head = (t: string) => paint.bold(t.toUpperCase());
  const swap = (t: string) => (self === "crosstalk" ? t : t.replace(/^crosstalk\b/, self));
  const parts = [`${paint.bold(`${self} ${c.name}${c.args ? ` ${c.args}` : ""}`)}`, "", c.summary + ".", ...(c.about ? ["", c.about] : [])];
  if (c.options?.length) parts.push("", head("Options"), columns(c.options));
  if (c.examples?.length) parts.push("", head("Examples"), c.examples.map((e) => `  ${swap(e)}`).join("\n"));
  if (c.aliases?.length) parts.push("", head("Also"), `  ${c.aliases.map((a) => `${self} ${a}`).join(", ")}`);
  return parts.join("\n");
}

/** The closest command to a mistyped one, when it is close enough to suggest. */
export function closest(word: string): string | undefined {
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of names) {
    const d = distance(word.toLowerCase(), n);
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best && bestD <= Math.max(1, Math.floor(best.length / 3)) ? (commandInfo(best)?.name ?? best) : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[b.length];
}

// ---------------------------------------------------------------- tab completion

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

export function completion(shell: Shell): string {
  const names = COMMANDS.map((c) => c.name);
  const flags = ["--in", "--json", "--no-color", "--help", "--version"];
  if (shell === "bash") {
    return `# Crosstalk tab completion for bash. Add to ~/.bashrc: eval "$(crosstalk completion bash)"
_crosstalk() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names.join(" ")}" -- "$cur") )
  elif [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${flags.join(" ")}" -- "$cur") )
  fi
}
complete -o default -F _crosstalk crosstalk
`;
  }
  if (shell === "zsh") {
    const q = (t: string) => t.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
    return `#compdef crosstalk
# Crosstalk tab completion for zsh. Add to ~/.zshrc: eval "$(crosstalk completion zsh)"
_crosstalk() {
  local -a commands
  commands=(
${COMMANDS.map((c) => `    '${q(c.name)}:${q(c.summary)}'`).join("\n")}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _files
  fi
}
if (( $+functions[compdef] )); then compdef _crosstalk crosstalk; fi
`;
  }
  if (shell === "fish") {
    const q = (t: string) => t.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `# Crosstalk tab completion for fish. Save as ~/.config/fish/completions/crosstalk.fish
${COMMANDS.map((c) => `complete -c crosstalk -n __fish_use_subcommand -f -a '${q(c.name)}' -d '${q(c.summary)}'`).join("\n")}
complete -c crosstalk -l in -r -d 'Work on this folder'
complete -c crosstalk -l json -d 'Output as JSON'
complete -c crosstalk -l no-color -d 'Plain text'
`;
  }
  const q = (t: string) => t.replace(/'/g, "''");
  return `# Crosstalk tab completion for PowerShell. Add to $PROFILE: crosstalk completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName crosstalk -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(
${COMMANDS.map((c) => `    @('${q(c.name)}', '${q(c.summary)}')`).join(",\n")}
  )
  $n = $commandAst.CommandElements.Count
  if ($n -eq 1 -or ($n -eq 2 -and $wordToComplete)) {
    $commands | Where-Object { $_[0] -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_[0], $_[0], 'ParameterValue', $_[1])
    }
  }
}
`;
}
