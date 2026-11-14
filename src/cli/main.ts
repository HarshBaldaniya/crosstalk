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
//   crosstalk setup | update | doctor | remove | version   install, keep current, check, take away
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkHome } from "../core/paths";
import { CodeMap } from "../codemap/index";
import { backUp, restore } from "../core/backup";
import { renderTokenReport, tokenReport } from "../core/tokens";
import { allCommands, suggest } from "../library/index";
import { doctor, latestVersion, newer, NPM_PACKAGE, remove, setup, VERSION } from "../core/setup";
import type { AgentId } from "../core/toolkit";

const HELP = `Crosstalk: every Claude Code, Codex and Gemini CLI chat in one place, a map of your code, and commands for every agent.

  crosstalk setup                 set up every agent on this computer (tools, skills, auto-sharing)
                                  --agents claude,codex,gemini   only these   --no-sharing   no hook
  crosstalk doctor                check that everything works, and say how to fix what doesn't
  crosstalk update                move to the newest version and refresh every agent
  crosstalk remove                take Crosstalk out of every agent (--purge also deletes its data)
  crosstalk version               this version, and whether a newer one is out

  crosstalk map [folder]          build or refresh the code map (about 1 MB, no AI)
  crosstalk find <words>          where something is: ranked, with path:start-end
  crosstalk outline <path|name>   a folder, file or symbol, one level, with lines
  crosstalk graph <name|path>     who uses it and what it uses (--hops 2 for more)
  crosstalk overview              commands, entry points, main parts, conventions
  crosstalk check unused|docs     unused code, or doc lines naming things that are gone
  crosstalk commands [words]      the commands, or the ones that fit a task
  crosstalk tokens <chat file>    where a Claude or Codex chat's tokens went
  crosstalk backup <folder>       copy session logs and your commands to a folder
  crosstalk restore <folder>      bring them back (merges; never loses anything)
  crosstalk mcp                   run the MCP server, for an agent's settings

Options: --in <folder> (default: this folder), --hops 2, --limit N

First time: npx ${NPM_PACKAGE} setup`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cmd = args.shift();
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
    case "setup": {
      const agents = option(args, "--agents")?.split(",").map((a) => a.trim().toLowerCase()).filter((a): a is AgentId => a === "claude" || a === "codex" || a === "gemini");
      const r = await setup({ fromDir: __dirname, agents, sharing: !argv.includes("--no-sharing"), skills: !argv.includes("--no-skills") });
      for (const l of r.lines) out(`  ${l}`);
      if (r.codexTrust) out("\n  One step left for Codex: type /hooks in Codex and trust Crosstalk's hook.");
      if (r.agents.length) out(`\n  Done. Restart open agent chats to pick it up. Check any time with: crosstalk doctor`);
      return r.agents.length ? 0 : 1;
    }
    case "doctor": {
      const checks = doctor(await latestVersion({ timeoutMs: 2500 }));
      for (const c of checks) {
        out(`  ${c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗"} ${c.what}`);
        if (c.ok !== true && c.fix) out(`      ${c.fix}`);
      }
      const bad = checks.filter((c) => c.ok === false).length;
      out(bad ? `\n  ${bad} thing${bad === 1 ? "" : "s"} to fix.` : "\n  Everything works.");
      return bad ? 1 : 0;
    }
    case "update": {
      const latest = await latestVersion({ force: true, timeoutMs: 6000 });
      if (!latest) {
        out(`  Couldn't reach npm. Try again online, or run: npx ${NPM_PACKAGE}@latest setup`);
        return 1;
      }
      if (!newer(latest, VERSION)) {
        // Already the newest: refresh every agent from this copy, in case anything drifted.
        const r = await setup({ fromDir: __dirname, sharing: true });
        out(`  Crosstalk ${VERSION} is the newest. Every agent refreshed (${r.agents.length}).`);
        return 0;
      }
      out(`  Updating Crosstalk ${VERSION} → ${latest} ...`);
      const win = process.platform === "win32";
      // Installed with npm -g: update that copy; otherwise run the new version's setup through npx.
      const global = /[\\/]node_modules[\\/]crosstalk-ai[\\/]/.test(__dirname) && !/[\\/]_npx[\\/]/.test(__dirname);
      if (global) {
        const g = spawnSync("npm", ["install", "-g", `${NPM_PACKAGE}@${latest}`], { stdio: "inherit", shell: win });
        if (g.status !== 0) return g.status ?? 1;
      }
      const r = spawnSync("npx", ["-y", `${NPM_PACKAGE}@${latest}`, "setup"], { stdio: "inherit", shell: win });
      return r.status ?? 1;
    }
    case "remove": {
      for (const l of await remove({ purge: argv.includes("--purge") })) out(`  ${l}`);
      out("\n  Restart open agent chats to finish. If you also use the VS Code extension, uninstall it in VS Code.");
      return 0;
    }
    case "version":
    case "--version":
    case "-v": {
      out(`crosstalk ${VERSION}`);
      const latest = await latestVersion({ timeoutMs: 2500 });
      if (latest && newer(latest, VERSION)) out(`${latest} is out: crosstalk update`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    default:
      out(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }

  function usage(what: string): number {
    out(`Usage: crosstalk ${what}`);
    return 2;
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
  if (!process.stderr.isTTY || !cmd || ["mcp", "update", "version", "--version", "-v", "doctor", "setup"].includes(cmd)) return;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(crosstalkHome(), "update-check.json"), "utf8")) as { latest?: string };
    if (c.latest && newer(c.latest, VERSION)) process.stderr.write(`\nCrosstalk ${c.latest} is out (you have ${VERSION}): crosstalk update\n`);
  } catch {
    // No check yet.
  }
}

