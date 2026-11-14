// Crosstalk from a terminal, on any computer: the same code map, Library and session tools as the
// extension, for CI, cloud agents and machines without VS Code. macOS, Windows and Linux.
//
//   node crosstalk.js map [folder]          build or refresh the code map
//   node crosstalk.js find <words>          where something is
//   node crosstalk.js outline <path|name>   one level of a folder, file or symbol
//   node crosstalk.js graph <name|path>     who uses it, what it uses (--hops 2)
//   node crosstalk.js overview              the project card
//   node crosstalk.js check unused|docs     clean-up candidates, stale doc lines
//   node crosstalk.js commands [words]      the Library, or the commands that fit a task
//   node crosstalk.js tokens <chat file>    where a chat's tokens went
//   node crosstalk.js backup <folder>       copy session logs to a folder
//   node crosstalk.js restore <folder>      bring them back on this computer
//   node crosstalk.js mcp                   run the MCP server (for an agent's config)
//   npx crosstalk-ai                        set up every agent (or, once set up, show what each has)
//   crosstalk doctor | update | remove | version   check, keep current, take away
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkHome } from "../core/paths";
import { findCommand } from "../core/hooks";
import { CodeMap } from "../codemap/index";
import { backUp, restore } from "../core/backup";
import { renderTokenReport, tokenReport } from "../core/tokens";
import { allCommands, suggest } from "../library/index";
import { agentSummary, doctor, installedVersion, latestVersion, needsSetup, newer, npmCommand, NPM_PACKAGE, remove, setup, VERSION, type AgentSummary } from "../core/setup";
import type { AgentId } from "../core/toolkit";

/** This copy is the `crosstalk` command installed with npm -g (not a one-off npx run). */
const GLOBAL = /[\\/]node_modules[\\/](crosstalk-ai|create-crosstalk)[\\/]/.test(__dirname) && !/[\\/]_npx[\\/]/.test(__dirname);

/** Crosstalk's own `crosstalk` command on the PATH, if there is one (another program could use the
 *  same name). npm -g links it into its package on macOS and Linux, and puts a .cmd beside it on Windows. */
function ourCommand(): string | undefined {
  const found = findCommand("crosstalk");
  if (!found) return undefined;
  try {
    if (/[\\/]node_modules[\\/]crosstalk-ai[\\/]/.test(fs.realpathSync(found))) return found;
  } catch {
    // A broken link: not usable.
  }
  return fs.existsSync(path.join(path.dirname(found), "node_modules", NPM_PACKAGE)) ? found : undefined;
}

/** How to type Crosstalk here: `crosstalk` once that command exists, otherwise through npx. */
let selfName: string | undefined;
const self = () => (selfName ??= GLOBAL || ourCommand() ? "crosstalk" : `npx ${NPM_PACKAGE}`);

const help = () => `Crosstalk ${VERSION}: a map of your code, your other chats' records and ready-made commands, for Claude Code, Codex and Gemini CLI.

Usage: ${self()} [command]

  (no command)                    set up every agent on this computer, or show what each one has
  doctor                          check that everything works, with the fix for anything that doesn't
  update                          move to the newest version and refresh every agent
  remove                          take Crosstalk out of every agent (--purge also deletes its data)
  setup                           set up again: --agents claude,codex,gemini   --no-sharing   --verbose
                                  --no-command leaves out the crosstalk command

  map [folder]                    build or refresh the code map (about 1 MB, no AI)
  find <words>                    where something is: ranked, with path:start-end
  outline <path|name>             a folder, file or symbol, one level, with lines
  graph <name|path>               who uses it and what it uses (--hops 2 for more)
  overview                        commands, entry points, main parts, conventions
  check unused|docs               unused code, or doc lines naming things that are gone
  commands [words]                the commands, or the ones that fit a task
  tokens <chat file>              where a Claude or Codex chat's tokens went
  backup <folder>                 copy session logs and your commands to a folder
  restore <folder>                bring them back (merges; never loses anything)
  mcp                             run the MCP server, for an agent's settings
  version                         this version, and whether a newer one is out

Options: --in <folder> (default: this folder), --hops 2, --limit N`;

// Plain words people reach for, mapped to the command that does it.
const ALIASES: Record<string, string> = { install: "setup", init: "setup", uninstall: "remove", upgrade: "update", status: "", "--help": "help", "-h": "help", "--version": "version", "-v": "version" };

// Colour only in a terminal that wants it (NO_COLOR, pipes and CI logs stay plain).
const colour = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const tint = (code: string) => (t: string) => (colour ? `\x1b[${code}m${t}\x1b[0m` : t);
const paint = { ok: tint("32"), warn: tint("33"), bad: tint("31"), dim: tint("2"), bold: tint("1") };

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  let first = args.shift();
  // `npx crosstalk-ai --agents codex` is the bare command with options.
  if (first?.startsWith("--") && !(first in ALIASES)) {
    args.unshift(first);
    first = undefined;
  }
  const cmd = first !== undefined && first in ALIASES ? ALIASES[first] || undefined : first;
  const folder = path.resolve(option(args, "--in") ?? process.cwd());
  const hops = option(args, "--hops") === "2" ? 2 : 1;
  const limit = Number(option(args, "--limit") ?? "") || undefined;
  const rest = args.join(" ").trim();
  const out = (t: string) => process.stdout.write(`${t}\n`);

  const freshMap = async (root = folder) => {
    const m = new CodeMap(root);
    await m.refresh({ yieldEvery: 1e9 });
    return m;
  };

  switch (cmd) {
    case "map": {
      const root = path.resolve(rest || folder);
      const m = new CodeMap(root);
      const s = await m.refresh({ yieldEvery: 1e9 });
      out(`${root}: ${s.files} files, ${s.decls} declarations; read ${s.parsed}, ${s.removed} gone, in ${(s.ms / 1000).toFixed(1)} s${s.bytes ? `, ${(s.bytes / 1024).toFixed(0)} KB` : ""}`);
      return 0;
    }
    case "find":
      if (!rest) return usage("find <words or a name>");
      out((await freshMap()).find(rest, { limit, budget: 600 }));
      return 0;
    case "outline":
      if (!rest) return usage("outline <path or name>");
      out((await freshMap()).outline(rest, 1200));
      return 0;
    case "graph":
      if (!rest) return usage("graph <name or path>");
      out((await freshMap()).graphOf(rest, hops as 1 | 2, 1200));
      return 0;
    case "overview":
      out((await freshMap()).overview(1200));
      return 0;
    case "check": {
      const m = await freshMap();
      if (rest === "unused") out(m.unusedText(3000));
      else if (rest === "docs") {
        const stale = m.staleDocs();
        out(stale.length ? stale.map((d) => `${d.file}:${d.line}  ${d.missing} (${d.kind}) no longer exists`).join("\n") : "Every file, hook and script the docs name exists.");
        // A stale doc line fails a CI step on purpose.
        return stale.length ? 1 : 0;
      } else return usage("check unused|docs");
      return 0;
    }
    case "commands": {
      const list = rest ? suggest(rest).map((s) => s.command) : allCommands();
      out(list.length ? list.map((c) => `/${c.name}  ${c.description}`).join("\n") : "No command fits; do it directly.");
      return 0;
    }
    case "tokens": {
      if (!rest) return usage("tokens <chat file (.jsonl)>");
      const file = path.resolve(rest);
      out(renderTokenReport(tokenReport(/[/\\]\.codex[/\\]|rollout-/.test(file) ? "codex" : "claude", file), path.basename(file)));
      return 0;
    }
    case "backup": {
      if (!rest) return usage("backup <folder>");
      const r = backUp(path.resolve(rest));
      out(`Backed up ${r.copied} new or changed of ${r.files} files to ${r.to}`);
      return 0;
    }
    case "restore": {
      if (!rest) return usage("restore <folder>");
      const r = restore(path.resolve(rest));
      out(r.from.length ? `Restored ${r.restored} files from ${r.from.join(", ")}` : `No Crosstalk backup in ${rest}`);
      return 0;
    }
    case "mcp":
      // The MCP server sits next to this file, both in a build and in ~/.crosstalk.
      if (!process.env.CROSSTALK_ROOT) process.env.CROSSTALK_ROOT = folder;
      require(path.join(__dirname, "crosstalk-mcp.js"));
      return -1;
    case undefined: {
      // The one command to remember: sets up what needs it, otherwise says how things stand.
      if (first !== "status" && needsSetup()) return runSetup(args, argv);
      const iv = installedVersion();
      if (iv && newer(iv, VERSION)) out(`\n  ${paint.dim(`Crosstalk ${iv} is installed; this is ${VERSION}. Run: npx ${NPM_PACKAGE}@latest`)}`);
      printAgents(agentSummary());
      const latest = await latestVersion({ timeoutMs: 1500 });
      if (latest && newer(latest, iv ?? VERSION)) out(`\n  ${paint.warn("!")} Crosstalk ${latest} is out. Run: ${self()} update`);
      out(`\n  Everything is set up. ${paint.dim(`${self()} doctor checks it, ${self()} help lists every command.`)}\n`);
      return 0;
    }
    case "setup":
      return runSetup(args, argv);
    case "doctor": {
      out(`\n  ${paint.bold(`Crosstalk ${installedVersion() ?? VERSION}`)}\n`);
      const checks = doctor(await latestVersion({ timeoutMs: 2500 }), self());
      for (const c of checks) {
        out(`  ${c.ok === true ? paint.ok("✓") : c.ok === "warn" ? paint.warn("!") : paint.bad("✗")} ${c.what}`);
        if (c.ok !== true && c.fix) out(`    ${paint.dim(c.fix)}`);
      }
      const bad = checks.filter((c) => c.ok === false).length;
      out(bad ? `\n  ${bad} thing${bad === 1 ? "" : "s"} to fix.\n` : "\n  Everything works.\n");
      return bad ? 1 : 0;
    }
    case "update": {
      const latest = await latestVersion({ force: true, timeoutMs: 6000 });
      if (!latest) {
        out(`  Couldn't reach npm. Try again online, or run: npx ${NPM_PACKAGE}@latest`);
        return 1;
      }
      if (!newer(latest, VERSION)) {
        // Already the newest: refresh every agent from this copy, in case anything drifted.
        await setup({ fromDir: __dirname });
        out(`\n  ${paint.ok("✓")} Crosstalk ${VERSION} is the newest, and every agent is refreshed.\n`);
        return 0;
      }
      out(`\n  Updating Crosstalk ${VERSION} → ${latest} ...\n`);
      // Installed with npm -g: update that copy too; then the new version sets every agent up.
      if (GLOBAL) {
        const g = run(npmCommand("npm", ["install", "-g", `${NPM_PACKAGE}@${latest}`]));
        if (g !== 0) return g;
      }
      return run(npmCommand("npx", ["-y", `${NPM_PACKAGE}@${latest}`, "setup"]));
    }
    case "remove": {
      for (const l of await remove({ purge: argv.includes("--purge") })) out(`  ${l}`);
      out("\n  Restart open agent chats to finish. If you also use the VS Code extension, uninstall it in VS Code.");
      if (GLOBAL || ourCommand()) out(`  ${paint.dim(`The crosstalk command stays until: npm uninstall --global ${NPM_PACKAGE}`)}`);
      out("");
      return 0;
    }
    case "version": {
      out(`crosstalk ${VERSION}`);
      const latest = await latestVersion({ timeoutMs: 2500 });
      if (latest && newer(latest, VERSION)) out(`${latest} is out. Run: ${self()} update`);
      return 0;
    }
    case "help":
      out(help());
      return 0;
    default:
      out(`Unknown command: ${first}. Run ${self()} help for the list.`);
      return 2;
  }

  function usage(what: string): number {
    out(`Usage: ${self()} ${what}`);
    return 2;
  }

  async function runSetup(rest: string[], all: string[]): Promise<number> {
    const agents = option(rest, "--agents")?.split(",").map((a) => a.trim().toLowerCase()).filter((a): a is AgentId => a === "claude" || a === "codex" || a === "gemini");
    out(`\n  ${paint.bold(`Crosstalk ${VERSION}`)}  ${paint.dim("setting up your agents")}`);
    const r = await setup({ fromDir: __dirname, agents, sharing: !all.includes("--no-sharing"), skills: !all.includes("--no-skills") });
    if (!r.agents.length) {
      out(`\n  No Claude Code, Codex or Gemini CLI found on this computer. Install one, then run: ${self()}\n`);
      return 1;
    }
    // The details (what changed, which files were backed up) only when asked, or when something failed.
    const details = all.includes("--verbose") ? r.lines : r.lines.filter((l) => /couldn't|failed|error/i.test(l));
    if (details.length) out(`\n${details.map((l) => `  ${paint.dim(l)}`).join("\n")}`);
    const list = agentSummary();
    printAgents(list);
    // Like pip: after the first `npm create crosstalk`, plain `crosstalk` works in any terminal.
    if (!all.includes("--no-command")) {
      const c = addCommand();
      if (c === true) out(`  ${paint.ok("✓")} ${"crosstalk".padEnd(Math.max(...list.map((a) => a.name.length)) + 3)}the command, in any new terminal`);
      else if (c) out(`  ${paint.warn("!")} Couldn't add the crosstalk command (${c}). ${paint.dim(`npx ${NPM_PACKAGE} does the same.`)}`);
    }
    if (r.codexTrust) out(`\n  ${paint.warn("!")} One step left for Codex: type /hooks in Codex and trust Crosstalk's hook.`);
    out(`\n  Done. Restart open agent chats to pick it up.`);
    out(`  ${paint.dim(`Check any time: ${self()} doctor`)}\n`);
    return list.every((a) => a.tools) ? 0 : 1;
  }

  function printAgents(list: AgentSummary[]): void {
    if (!list.length) {
      out(`\n  No Claude Code, Codex or Gemini CLI found. Install one, then run: ${self()}`);
      return;
    }
    const width = Math.max(...list.map((a) => a.name.length)) + 3;
    out("");
    for (const a of list) {
      const has = [a.plugin ? "tools and skills (plugin)" : a.tools ? "tools" : "", a.skills ? "skills" : "", a.sharing ? "auto-sharing" : ""].filter(Boolean);
      const off = [!a.tools ? "tools missing" : "", a.skills === false ? "no skills" : "", !a.sharing ? "auto-sharing off" : ""].filter(Boolean);
      out(`  ${a.tools ? paint.ok("✓") : paint.bad("✗")} ${a.name.padEnd(width)}${has.join(" · ")}${off.length ? paint.dim(`${has.length ? " · " : ""}${off.join(" · ")}`) : ""}`);
    }
  }

  /** Installs this version as the `crosstalk` command: true when it is there, a reason when it
   *  couldn't be added, undefined when it already was. */
  function addCommand(): true | string | undefined {
    if (GLOBAL || ourCommand()) return undefined;
    const c = npmCommand("npm", ["install", "--global", "--no-fund", "--no-audit", "--loglevel=error", `${NPM_PACKAGE}@${VERSION}`]);
    const r = spawnSync(c.cmd, c.args, { encoding: "utf8", shell: c.shell, windowsHide: true, timeout: 180_000 });
    selfName = undefined;
    if (r.status === 0) return true;
    const why = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    return /EACCES|permission/i.test(why) ? "npm needs admin rights for global installs here" : /E404|404/.test(why) ? "not on npm yet" : "npm install failed";
  }

  function run(c: { cmd: string; args: string[]; shell: boolean }): number {
    return spawnSync(c.cmd, c.args, { stdio: "inherit", shell: c.shell, windowsHide: true }).status ?? 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) {
        updateNote(process.argv[2]);
        process.exit(code);
      }
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

/** After an everyday command in a terminal: one line when a newer version is out. It reads only the
 *  answer kept from the last daily check, so a command is never slowed down by a network call. */
function updateNote(cmd: string | undefined): void {
  const quiet = ["mcp", "update", "version", "--version", "-v", "doctor", "setup", "install", "init", "status", "upgrade"];
  if (!process.stderr.isTTY || !cmd || quiet.includes(cmd)) return;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(crosstalkHome(), "update-check.json"), "utf8")) as { latest?: string };
    if (c.latest && newer(c.latest, VERSION)) process.stderr.write(`\nCrosstalk ${c.latest} is out (you have ${VERSION}). Run: ${self()} update\n`);
  } catch {
    // No check yet.
  }
}

