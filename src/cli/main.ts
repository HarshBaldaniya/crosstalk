// Crosstalk from a terminal, on any computer: setup for every agent, and the same code map, commands
// and session tools as the extension, for CI, cloud agents and machines without VS Code. The same on
// macOS, Windows and Linux. Every command is described once, in ./help.ts.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkHome } from "../core/paths";
import { CodeMap } from "../codemap/index";
import { backUp, restore } from "../core/backup";
import { renderTokenReport, tokenReport } from "../core/tokens";
import { allCommands, suggest } from "../library/index";
import { agentSummary, doctor, installedVersion, latestVersion, needsSetup, newer, NPM_PACKAGE, remove, setup, updateChecksOff, VERSION, type AgentSummary } from "../core/setup";
import type { AgentId } from "../core/toolkit";
import { aboutInfo, bugUrl, CHANGELOG, DOCS, openUrl, REPO } from "./about";
import { closest, commandInfo, completion, renderCommandHelp, renderHelp, SHELLS, type Shell } from "./help";
import { globalInstall, oneOff, ourCommand, pmCommand, startedBy, type OurCommand, type PackageManager } from "./pm";
import { columns, out, paint, plain } from "./ui";

/** The `crosstalk` command, looked up once (it asks the login shell, so not for every command). */
let command: OurCommand | null | undefined;
const theCommand = () => (command === undefined ? (command = ourCommand() ?? null) : command) ?? undefined;

/** How to type Crosstalk here: `crosstalk` once that command exists, otherwise the one-off form of
 *  the package manager that started this run (npx, pnpm dlx, yarn dlx, bunx). */
const self = () => (theCommand() ? "crosstalk" : oneOff(startedBy()));

const uninstallLine = (by: PackageManager) =>
  by === "pnpm" ? `pnpm remove --global ${NPM_PACKAGE}` : by === "bun" ? `bun remove --global ${NPM_PACKAGE}` : by === "yarn" ? `yarn global remove ${NPM_PACKAGE}` : `npm uninstall --global ${NPM_PACKAGE}`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** Takes a flag out of the arguments; true when it was there. */
function flag(args: string[], ...names: string[]): boolean {
  let found = false;
  for (let i = args.length - 1; i >= 0; i--) {
    if (names.includes(args[i])) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

const json = (v: unknown) => out(JSON.stringify(v, null, 2));

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  if (flag(args, "--no-color", "--no-colour")) plain();
  const asJson = flag(args, "--json");
  const wantsHelp = flag(args, "-h", "--help");
  const wantsVersion = args[0] === "-v" || args[0] === "--version";
  let first = wantsVersion ? (args.shift(), "version") : args[0]?.startsWith("-") ? undefined : args.shift();
  if (wantsHelp && !first) first = "help";
  const info = first ? commandInfo(first) : undefined;
  const cmd = info?.name ?? first;
  if (wantsHelp && info && cmd !== "help") {
    out(renderCommandHelp(info, self()));
    return 0;
  }
  const folder = path.resolve(option(args, "--in") ?? process.cwd());
  const hops = option(args, "--hops") === "2" ? 2 : 1;
  const limit = Number(option(args, "--limit") ?? "") || undefined;
  const rest = args.filter((a) => !a.startsWith("--")).join(" ").trim();

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
    case undefined:
    case "status": {
      // The one command to remember: sets up what needs it, otherwise says how things stand.
      if (cmd === undefined && !asJson && needsSetup()) return runSetup(args, argv);
      const list = agentSummary();
      if (asJson) {
        json({ version: VERSION, installed: installedVersion() ?? null, setUp: !needsSetup(), agents: list });
        return 0;
      }
      const iv = installedVersion();
      if (iv && newer(iv, VERSION)) out(`\n  ${paint.dim(`Crosstalk ${iv} is installed; this copy is ${VERSION}.`)}`);
      printAgents(list);
      const latest = await latestVersion({ timeoutMs: 1500 });
      if (latest && newer(latest, iv ?? VERSION)) out(`\n  ${paint.warn("!")} Crosstalk ${latest} is out. Run: ${self()} update`);
      out(needsSetup() ? `\n  Something needs setting up. Run: ${self()}\n` : `\n  Everything is set up. ${paint.dim(`${self()} help lists every command.`)}\n`);
      return 0;
    }
    case "setup":
      return runSetup(args, argv);
    case "doctor": {
      const checks = doctor(await latestVersion({ timeoutMs: 2500 }), self());
      const bad = checks.filter((c) => c.ok === false).length;
      if (asJson) {
        json({ ok: bad === 0, version: VERSION, checks });
        return bad ? 1 : 0;
      }
      out(`\n  ${paint.bold(`Crosstalk ${installedVersion() ?? VERSION}`)}\n`);
      for (const c of checks) {
        out(`  ${c.ok === true ? paint.ok("✓") : c.ok === "warn" ? paint.warn("!") : paint.bad("✗")} ${c.what}`);
        if (c.ok !== true && c.fix) out(`    ${paint.dim(c.fix)}`);
      }
      out(bad ? `\n  ${bad} thing${bad === 1 ? "" : "s"} to fix.\n` : "\n  Everything works.\n");
      return bad ? 1 : 0;
    }
    case "update":
      return update(argv.includes("--check"));
    case "remove": {
      for (const l of await remove({ purge: argv.includes("--purge") })) out(`  ${l}`);
      out("\n  Restart open agent chats to finish. If you also use the VS Code extension, uninstall it in VS Code.");
      const c = theCommand();
      if (c) out(`  ${paint.dim(`The crosstalk command stays until: ${uninstallLine(c.by)}`)}`);
      out("");
      return 0;
    }
    case "version": {
      const latest = await latestVersion({ timeoutMs: 2500 });
      if (asJson) {
        json(aboutInfo(theCommand(), latest));
        return 0;
      }
      out(`crosstalk ${VERSION}`);
      if (latest && newer(latest, VERSION)) out(`${paint.warn(`${latest} is out.`)} Run: ${self()} update  ${paint.dim(CHANGELOG)}`);
      return 0;
    }
    case "about": {
      const a = aboutInfo(theCommand(), await latestVersion({ timeoutMs: 2500 }));
      if (asJson) {
        json({ ...a, license: "MIT", homepage: REPO, docs: DOCS, changelog: CHANGELOG });
        return 0;
      }
      const state = !a.latest ? paint.dim("couldn't check for a newer one") : newer(a.latest, a.version) ? paint.warn(`${a.latest} is out: ${self()} update`) : paint.ok("the newest");
      out(`\n  ${paint.bold(`Crosstalk ${a.version}`)}`);
      out(`  ${paint.dim("A map of your code, your other chats' records and ready-made commands, for every agent.")}\n`);
      out(
        columns([
          ["Version", `${a.version} · ${state}`],
          ["Node.js", a.node],
          ["System", a.system],
          ["Files", `${a.files}${a.filesVersion && a.filesVersion !== a.version ? ` (${a.filesVersion})` : ""}`],
          ["Command", a.command ? `${a.command} · ${a.installedWith}` : paint.dim(`not installed (${self()} setup adds it)`)],
          ["Agents", a.agents.join(", ") || paint.dim("none found")],
        ]),
      );
      out("");
      out(columns([["Guide", DOCS], ["Changes", CHANGELOG], ["Problems", `${self()} bug`], ["License", "MIT © Harsh Baldaniya"]]));
      out("");
      return 0;
    }
    case "docs":
      out(`Opening the guide: ${DOCS}`);
      if (process.stdout.isTTY) openUrl(DOCS);
      return 0;
    case "bug": {
      const url = bugUrl(aboutInfo(theCommand()));
      out("Opening a new GitHub issue with your version and system filled in. Nothing is sent until you press Submit.");
      out(paint.dim(url));
      if (process.stdout.isTTY) openUrl(url);
      return 0;
    }
    case "completion": {
      const shell = rest.toLowerCase() as Shell;
      if (!SHELLS.includes(shell)) {
        out(renderCommandHelp(commandInfo("completion")!, self()));
        return rest ? 2 : 0;
      }
      process.stdout.write(completion(shell));
      return 0;
    }
    case "help": {
      const about = rest ? commandInfo(rest) : undefined;
      if (rest && !about) return unknown(rest);
      out(about ? renderCommandHelp(about, self()) : renderHelp(self()));
      return 0;
    }
    default:
      return unknown(first ?? "");
  }

  function unknown(word: string): number {
    const near = closest(word);
    out(`Unknown command "${word}".${near ? ` Did you mean ${paint.bold(near)}?` : ""} Run ${self()} help for the list.`);
    return 2;
  }

  function usage(what: string): number {
    out(`Usage: ${self()} ${what}`);
    return 2;
  }

  async function update(checkOnly: boolean): Promise<number> {
    const latest = await latestVersion({ force: true, timeoutMs: 6000 });
    if (!latest) {
      out(`  Couldn't reach npm. Try again when you are online.`);
      return 1;
    }
    const current = !newer(latest, VERSION);
    if (checkOnly) {
      out(current ? `Crosstalk ${VERSION} is the newest.` : `Crosstalk ${latest} is out (you have ${VERSION}). Run: ${self()} update  ${paint.dim(CHANGELOG)}`);
      return 0;
    }
    if (current) {
      // Already the newest: refresh every agent from this copy, in case anything drifted.
      await setup({ fromDir: __dirname });
      out(`\n  ${paint.ok("✓")} Crosstalk ${VERSION} is the newest, and every agent is refreshed.\n`);
      return 0;
    }
    out(`\n  Updating Crosstalk ${VERSION} → ${latest} ...\n`);
    const spec = `${NPM_PACKAGE}@${latest}`;
    const c = theCommand();
    if (c) {
      // The crosstalk command: update it with the package manager that installed it, then let the
      // new version set every agent up.
      const g = globalInstall(c.by, spec);
      const code = run(pmCommand(g.bin, g.args));
      if (code !== 0) {
        out(`\n  ${paint.bad("✗")} ${g.bin} couldn't update it. Try: ${[g.bin, ...g.args].join(" ")}`);
        return code;
      }
      const win = process.platform === "win32";
      return run(win ? { cmd: `"${c.path}" setup --no-command`, args: [], shell: true } : { cmd: c.path, args: ["setup", "--no-command"], shell: false });
    }
    const pm = startedBy();
    const once: [PackageManager | "npx", string[]] =
      pm === "pnpm" ? ["pnpm", ["dlx", spec, "setup"]] : pm === "bun" ? ["bun", ["x", spec, "setup"]] : pm === "yarn" && !/^yarn\/1\./.test(process.env.npm_config_user_agent ?? "") ? ["yarn", ["dlx", spec, "setup"]] : ["npx", ["-y", spec, "setup"]];
    return run(pmCommand(...once));
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
      const pad = Math.max(...list.map((a) => a.name.length)) + 3;
      if (c === true) out(`  ${paint.ok("✓")} ${"crosstalk".padEnd(pad)}the command, in any new terminal`);
      else if (c) out(`  ${paint.warn("!")} ${"crosstalk".padEnd(pad)}${paint.dim(`couldn't add the command (${c}); ${self()} does the same`)}`);
    }
    if (r.codexTrust) out(`\n  ${paint.warn("!")} One step left for Codex: type /hooks in Codex and trust Crosstalk's hook.`);
    out(`\n  Done. Restart open agent chats to pick it up.`);
    out(`  ${paint.dim(`Check any time: ${self()} doctor · every command: ${self()} help`)}\n`);
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

  /** Installs this version as the `crosstalk` command, with the package manager that started this
   *  run (npm when that one can't: Yarn 2+, or pnpm without a global folder). True when added, a
   *  reason when it couldn't be, undefined when it was already there. */
  function addCommand(): true | string | undefined {
    if (theCommand()) return undefined;
    const spec = `${NPM_PACKAGE}@${VERSION}`;
    const tries = [startedBy(), "npm" as const].filter((pm, i, all) => all.indexOf(pm) === i);
    let why = "";
    for (const pm of tries) {
      const g = globalInstall(pm, spec);
      const c = pmCommand(g.bin, g.args);
      const r = spawnSync(c.cmd, c.args, { encoding: "utf8", shell: c.shell, windowsHide: true, timeout: 180_000 });
      if (r.status === 0) {
        command = undefined;
        return true;
      }
      why = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    }
    return /EACCES|EPERM|permission/i.test(why) ? "global installs need admin rights here" : /E404|404/.test(why) ? "not on npm yet" : "the install failed";
  }

  function run(c: { cmd: string; args: string[]; shell: boolean }): number {
    return spawnSync(c.cmd, c.args, { stdio: "inherit", shell: c.shell, windowsHide: true }).status ?? 1;
  }
}

/** After an everyday command in a terminal: one line when a newer version is out. It reads only the
 *  answer kept from the last daily check, so a command is never slowed down by a network call. */
export function updateNote(cmd: string | undefined): void {
  const quiet = ["mcp", "update", "upgrade", "version", "--version", "-v", "about", "doctor", "setup", "install", "init", "status", "completion", "help", "--help", "-h"];
  if (!process.stderr.isTTY || !cmd || quiet.includes(cmd) || process.argv.includes("--json") || updateChecksOff()) return;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(crosstalkHome(), "update-check.json"), "utf8")) as { latest?: string };
    if (c.latest && newer(c.latest, VERSION)) process.stderr.write(`\nCrosstalk ${c.latest} is out (you have ${VERSION}). Run: ${self()} update\n`);
  } catch {
    // No check yet.
  }
}

