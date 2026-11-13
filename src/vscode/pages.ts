// What the Code and Library pages show, read from the code map, the Library and the session logs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodeMap } from "../codemap/index";
import { memberName } from "../codemap/graph";
import type { CodeHitView, CodeMapView, CodeModuleView, LibraryView } from "../core/protocol";
import { listHeads, readAsks } from "../core/record";
import { agentStates } from "../core/toolkit";
import { allCommands, PACKS, userLibraryDir } from "../library/index";

const rel = (root: string, f: string) => path.relative(root, f).split(path.sep).join("/");

/** Projects that can be mapped: this window's folders first, then folders picked to map, then folders
 *  chats ran in that still exist. */
export function knownProjects(here: string[], picked: string[] = []): CodeMapView["projects"] {
  const seen = new Set<string>();
  const out: CodeMapView["projects"] = [];
  const add = (root: string, isHere: boolean) => {
    const r = path.resolve(root);
    if (seen.has(r) || !fs.existsSync(r) || r === path.parse(r).root || r === os.homedir()) return;
    seen.add(r);
    out.push({ root: r, name: path.basename(r), here: isHere });
  };
  for (const h of here) add(h, true);
  for (const p of picked) add(p, false);
  for (const h of listHeads().sort((a, b) => b.updatedAt - a.updatedAt)) if (h.cwd && !/\/(tmp|private\/tmp|var\/folders)\//.test(h.cwd)) add(h.cwd, false);
  return out.slice(0, 30);
}

export function codeMapView(map: CodeMap, root: string): CodeMapView {
  const files = [...map.entries()];
  const languages: Record<string, number> = {};
  let decls = 0;
  for (const f of files) {
    languages[f.l] = (languages[f.l] ?? 0) + 1;
    decls += f.d.length;
  }

  const graph = map.graph;
  const modules = map.modules().slice(0, 60).map((m) => {
    const d = map.moduleDoc(m.id);
    return {
      id: m.id,
      files: m.files.length,
      rank: m.rank,
      dependsOn: m.dependsOn,
      doc: {
        status: d?.status ?? "missing",
        changed: d?.status === "approved" && d.approvedCode !== d.currentCode,
        changedFiles: d?.changedFiles,
        approvedOn: d?.approvedOn,
      },
      topFiles: [...m.files]
        .sort((a, b) => (graph.rank.get(b) ?? 0) - (graph.rank.get(a) ?? 0))
        .slice(0, 8)
        .map((p) => ({ p, decls: map.file(p)?.d.length ?? 0, importers: graph.importers.get(p)?.size ?? 0 })),
      kinds: kindsOf(map, m.files),
    };
  });
  const shown = new Set(modules.map((m) => m.id));
  const edges: CodeMapView["edges"] = [];
  for (const m of map.modules()) {
    if (!shown.has(m.id)) continue;
    for (const [to, weight] of Object.entries(m.depCounts ?? {})) if (shown.has(to) && to !== m.id) edges.push({ from: m.id, to, weight });
  }

  const allFiles = modules
    .flatMap((m) =>
      (map.moduleOrFolder(m.id)?.files ?? []).map((p) => {
        // What the file mostly is: its first exported declaration's kind, else its first one's.
        const d = map.file(p)?.d.filter((x) => !x.p) ?? [];
        const main = d.find((x) => x.x) ?? d[0];
        return { p, m: m.id, importers: graph.importers.get(p)?.size ?? 0, k: main?.k };
      }),
    )
    .slice(0, 6000);
  const at = new Map(allFiles.map((f, i) => [f.p, i]));
  const links: [number, number][] = [];
  for (const [i, f] of allFiles.entries()) {
    for (const t of graph.imports.get(f.p) ?? []) {
      const j = at.get(t);
      if (j !== undefined && j !== i) links.push([i, j]);
    }
    if (links.length > 40_000) break;
  }

  const u = map.unused();
  return {
    root,
    files: files.length,
    decls,
    languages,
    modules,
    edges,
    unused: { files: u.files.length, exports: u.exports.length, localOnly: u.localOnly.length, sample: [...u.files.slice(0, 4), ...u.exports.slice(0, 6).map((e) => `${e.decl.n} (${e.file})`)] },
    staleDocs: map.staleDocs().slice(0, 30).map((d) => ({ file: d.file, line: d.line, missing: d.missing })),
    conventions: map.conventions().filter((c) => c.share >= 0.6).slice(0, 6).map((c) => `${c.topic}: ${c.rule} (${Math.round(c.share * 100)}%)`),
    allFiles,
    links,
    projects: [],
  };
}

function kindsOf(map: CodeMap, files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of files) for (const d of map.file(p)?.d ?? []) if (!d.p) out[d.k] = (out[d.k] ?? 0) + 1;
  return out;
}

/** A module opened up: its files (most imported first), imports between them, imports leaving it. */
export function codeModuleView(map: CodeMap, id: string): CodeModuleView | undefined {
  const m = map.moduleOrFolder(id);
  if (!m) return undefined;
  const graph = map.graph;
  const files = [...m.files].sort((a, b) => (graph.rank.get(b) ?? 0) - (graph.rank.get(a) ?? 0)).slice(0, 40);
  const inside = new Set(files);
  const moduleOf = new Map<string, string>();
  for (const mod of map.modules()) for (const f of mod.files) moduleOf.set(f, mod.id);
  const edges: CodeModuleView["edges"] = [];
  const out: CodeModuleView["out"] = [];
  for (const f of files) {
    for (const t of graph.imports.get(f) ?? []) {
      if (inside.has(t)) edges.push({ from: f, to: t });
      else {
        const other = moduleOf.get(t);
        if (other && other !== id && !out.some((o) => o.from === f && o.module === other)) out.push({ from: f, module: other });
      }
    }
  }
  return {
    id,
    files: files.map((p) => {
      const decls = map.file(p)?.d.filter((d) => !d.p) ?? [];
      const main = decls.find((d) => d.x) ?? decls[0];
      return { p, decls: decls.length, importers: graph.importers.get(p)?.size ?? 0, main: main?.n, kind: main?.k };
    }),
    edges,
    out,
  };
}

export function codeHits(map: CodeMap, q: string): CodeHitView[] {
  const out: CodeHitView[] = [];
  const perFile = new Map<string, number>();
  for (const h of map.findHits(q)) {
    const d = h.doc.decl;
    if (!d) continue;
    const n = perFile.get(h.doc.file.p) ?? 0;
    if (n >= 3) continue;
    perFile.set(h.doc.file.p, n + 1);
    out.push({ name: d.p ? `${d.p}.${d.n}` : d.n, kind: d.route ?? d.k, path: h.doc.file.p, start: d.s, end: d.e, usedBy: map.graph.usedBy(h.doc.file.p, memberName(d)).length, doc: d.d });
    if (out.length >= 25) break;
  }
  return out;
}

let usedCache: { at: number; counts: Map<string, number> } | undefined;

/** How often each command was run, from every session log on this computer (read at most every minute). */
function usageCounts(names: { name: string; body: string }[]): Map<string, number> {
  if (usedCache && Date.now() - usedCache.at < 60_000) return usedCache.counts;
  const counts = new Map<string, number>();
  // A run shows as the command typed, or as its instructions (what an MCP prompt sends).
  const starts = names.map((c) => ({ name: c.name, prefix: c.body.split("{{")[0].trim().slice(0, 40), typed: new RegExp(`(^|\\s)/(crosstalk:|mcp__crosstalk__|prompts:)?${c.name}(\\s|$)`) }));
  for (const h of listHeads()) {
    for (const a of readAsks(h.id)) {
      const text = a.ask.trim();
      for (const s of starts) {
        if (s.typed.test(text.slice(0, 120)) || (s.prefix.length >= 12 && text.startsWith(s.prefix))) {
          counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
          break;
        }
      }
    }
  }
  usedCache = { at: Date.now(), counts };
  return counts;
}

export function libraryView(): LibraryView {
  const cmds = allCommands();
  const used = usageCounts(cmds);
  return {
    packs: PACKS,
    commands: cmds.map((c) => ({ name: c.name, title: c.title, pack: c.pack, description: c.description, args: c.args, needs: c.needs, source: c.source, used: used.get(c.name) ?? 0 })),
    agents: agentStates().map((a) => ({ id: a.id, name: a.name, present: a.present, tools: a.tools, commands: a.commands })),
    folder: userLibraryDir(),
  };
}
