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
import * as path from "node:path";
import { CodeMap } from "../codemap/index";
import { backUp, restore } from "../core/backup";
import { renderTokenReport, tokenReport } from "../core/tokens";
import { allCommands, suggest } from "../library/index";

const HELP = `Crosstalk: a code map, commands and session logs for every AI agent.

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

Options: --in <folder> (default: this folder), --hops 2, --limit N`;

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
      if (code >= 0) process.exit(code);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
