// The code map: every file, declaration, import and caller of a codebase, read by a parser (no AI),
// kept fresh by content hash, and answered in a few hundred tokens with exact `path:start-end`.
import * as fs from "node:fs";
import * as path from "node:path";
import { extract, type Decl } from "./extract";
import { CodeGraph, memberName, type Confidence, type Edge } from "./graph";
import { checkDocs, computeConventions, computeModules, conventionLines, type Convention, type Module, type StaleDocLine } from "./modules";
import { approveModuleDoc, docPath, readModuleDoc, serveModuleDoc, type ModuleDoc } from "./moduledocs";
import { langOf } from "./parser";
import { makeResolver, type Resolver } from "./resolve";
import { isLowValuePath, SearchIndex, words, type Doc, type Hit } from "./search";
import { contentHash, listFiles, loadEntries, MAX_FILE_BYTES, readMeta, saveEntries, storeDir, type FileEntry } from "./store";

export interface CodeMapStats {
  files: number;
  decls: number;
  parsed: number;
  removed: number;
  ms: number;
  bytes?: number;
}

export interface FindOptions {
  /** Most lines in the answer */
  limit?: number;
  /** Token budget for the answer (about 4 characters a token) */
  budget?: number;
  /** Files this chat has worked on: ranked up */
  focus?: string[];
}

/** About four characters a token: the usual rule of thumb for code and English. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);

const LIST_EVERY_MS = 30_000;

export class CodeMap {
  private files = new Map<string, FileEntry>();
  private loaded = false;
  private lastListed = 0;
  /** Each mapped folder's modified time when last listed: a new or removed file changes it. */
  private dirTimes = new Map<string, number>();
  private resolverCache?: Resolver;
  private graphCache?: CodeGraph;
  private searchCache?: SearchIndex;
  private modulesCache?: Module[];
  private docsCache?: { at: number; lines: StaleDocLine[] };
  private sweeping?: Promise<CodeMapStats>;

  constructor(readonly root: string) {}

  private load() {
    if (this.loaded) return;
    this.files = loadEntries(this.root);
    this.loaded = true;
  }

  private invalidate() {
    this.resolverCache = undefined;
    this.graphCache = undefined;
    this.searchCache = undefined;
    this.modulesCache = undefined;
    this.docsCache = undefined;
  }

  /** The code's main parts, most depended on first. */
  modules(): Module[] {
    this.load();
    return (this.modulesCache ??= computeModules(this.files.values(), this.graph));
  }

  moduleOf(file: string): Module | undefined {
    return this.modules().find((m) => m.files.includes(file));
  }

  /** How this codebase (or one module) names and lays things out. */
  conventions(moduleId?: string): Convention[] {
    this.load();
    const files = moduleId ? (this.modules().find((m) => m.id === moduleId)?.files ?? []).map((p) => this.files.get(p)!).filter(Boolean) : [...this.files.values()];
    return computeConventions(files);
  }

  /** A module's doc: missing, draft or approved, and whether its code moved on since. */
  moduleDoc(moduleId: string): ModuleDoc | undefined {
    const m = this.moduleOrFolder(moduleId);
    return m ? readModuleDoc(this.root, m, this.files, storeDir(this.root)) : undefined;
  }

  approveModuleDoc(moduleId: string): ModuleDoc | undefined {
    const m = this.moduleOrFolder(moduleId);
    return m ? approveModuleDoc(this.root, m, this.files, storeDir(this.root)) : undefined;
  }

  /**
   * A module by id, or any folder taken as one. A part of the code with a doc keeps its name even
   * if it shrinks below a module's size, or the grouping around it changes.
   */
  moduleOrFolder(id: string): Module | undefined {
    const found = this.modules().find((x) => x.id === id);
    if (found) return found;
    const prefix = `${id.replace(/\/$/, "")}/`;
    const files = [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
    return files.length ? { id: id.replace(/\/$/, ""), files, rank: 0, cohesion: 1, dependsOn: [] } : undefined;
  }

  /** Whether a name a doc mentions still exists: a file, a folder, or a declaration. */
  nameExists(name: string): boolean {
    this.load();
    const rel = name.replace(/^\.\//, "");
    if (this.files.has(rel) || fs.existsSync(path.join(this.root, rel))) return true;
    for (const f of this.files.values()) if (f.d.some((d) => d.n === name)) return true;
    return false;
  }

  /** Doc lines naming a file, symbol or script that no longer exists (checked at most every 10 s). */
  staleDocs(): StaleDocLine[] {
    this.load();
    if (this.docsCache && Date.now() - this.docsCache.at < 10_000) return this.docsCache.lines;
    const lines = checkDocs(this.root, this.files, new Set(this.files.keys()));
    this.docsCache = { at: Date.now(), lines };
    return lines;
  }

  get resolver(): Resolver {
    this.load();
    return (this.resolverCache ??= makeResolver(this.root, new Set(this.files.keys())));
  }

  get graph(): CodeGraph {
    return (this.graphCache ??= new CodeGraph(this.files, this.resolver));
  }

  private get search(): SearchIndex {
    return (this.searchCache ??= new SearchIndex(this.files.values()));
  }

  entries(): Iterable<FileEntry> {
    this.load();
    return this.files.values();
  }

  file(p: string): FileEntry | undefined {
    this.load();
    return this.files.get(p);
  }

  /** Whether a map has been built for this folder. */
  exists(): boolean {
    return !!readMeta(this.root);
  }

  /**
   * Brings the map up to date. With `changed`, only those files are looked at (a save); otherwise every
   * known file's size and time is checked, and the file list itself at most every 30 s. Only files whose
   * content changed are parsed again. Never runs twice at once.
   */
  refresh(opts: { changed?: string[]; full?: boolean; yieldEvery?: number } = {}): Promise<CodeMapStats> {
    if (this.sweeping) return this.sweeping.then(() => this.refresh(opts));
    this.sweeping = this.doRefresh(opts).finally(() => (this.sweeping = undefined));
    return this.sweeping;
  }

  private async doRefresh({ changed, full, yieldEvery = 12 }: { changed?: string[]; full?: boolean; yieldEvery?: number }): Promise<CodeMapStats> {
    const t0 = Date.now();
    this.load();
    let paths: string[];
    let removed = 0;
    const listing = full || !this.files.size || Date.now() - this.lastListed > LIST_EVERY_MS || this.foldersChanged();
    if (changed && !full) {
      paths = changed.map((p) => (path.isAbsolute(p) ? path.relative(this.root, p) : p).split(path.sep).join("/")).filter((p) => !p.startsWith(".."));
    } else if (listing) {
      paths = await listFiles(this.root);
      this.lastListed = Date.now();
      this.rememberFolders(paths);
      // Which imports are this codebase's own depends on its folders: decide with today's list,
      // not the one from before (on a first build, an empty one).
      this.resolverCache = makeResolver(this.root, new Set(paths));
      const keep = new Set(paths);
      for (const p of [...this.files.keys()]) {
        if (!keep.has(p)) {
          this.files.delete(p);
          removed++;
        }
      }
    } else {
      paths = [...this.files.keys()];
    }

    const isLocal = (s: string) => this.resolver.isLocal(s);
    let parsed = 0;
    let lastYield = Date.now();
    for (const p of paths) {
      if (!langOf(p)) continue;
      const abs = path.join(this.root, p);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        if (this.files.delete(p)) removed++;
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) {
        if (this.files.delete(p)) removed++;
        continue;
      }
      const prev = this.files.get(p);
      if (prev && prev.z === st.size && prev.m === Math.floor(st.mtimeMs)) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const h = contentHash(text);
      if (prev && prev.h === h) {
        prev.m = Math.floor(st.mtimeMs);
        prev.z = st.size;
        parsed++; // the time changed; counts as touched so the store is saved
        continue;
      }
      try {
        const facts = await extract(langOf(p)!, text, isLocal);
        const entry: FileEntry = { p, l: langOf(p)!, h, z: st.size, m: Math.floor(st.mtimeMs), n: facts.lines, d: facts.decls, i: facts.imports };
        if (facts.def) entry.def = facts.def;
        this.files.set(p, entry);
        parsed++;
      } catch {
        // A file the parser can't read stays as it was; the next save tries again.
      }
      // Give the host a breath now and then, so a full build never freezes the editor.
      if (Date.now() - lastYield > yieldEvery) {
        await new Promise((r) => setImmediate(r));
        lastYield = Date.now();
      }
    }

    let bytes: number | undefined;
    if (parsed || removed || !this.exists()) {
      // Paths can appear or vanish: the resolver's file list must follow.
      this.invalidate();
      bytes = saveEntries(this.root, [...this.files.values()].sort((a, b) => (a.p < b.p ? -1 : 1))).bytes;
    }
    let decls = 0;
    for (const f of this.files.values()) decls += f.d.length;
    return { files: this.files.size, decls, parsed, removed, ms: Date.now() - t0, bytes };
  }

  private rememberFolders(paths: string[]) {
    this.dirTimes.clear();
    const dirs = new Set<string>([""]);
    for (const p of paths) {
      let d = path.posix.dirname(p);
      while (d !== "." && !dirs.has(d)) {
        dirs.add(d);
        d = path.posix.dirname(d);
      }
    }
    for (const d of dirs) {
      try {
        this.dirTimes.set(d, fs.statSync(path.join(this.root, d)).mtimeMs);
      } catch {
        // Gone already; the next listing settles it.
      }
    }
  }

  /** Whether any mapped folder gained or lost an entry since the last listing (a stat per folder). */
  private foldersChanged(): boolean {
    if (!this.dirTimes.size) return false;
    for (const [d, t] of this.dirTimes) {
      try {
        if (fs.statSync(path.join(this.root, d)).mtimeMs !== t) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ answers

  private boostFor(focus?: string[]): (doc: Doc) => number {
    const graph = this.graph;
    const rank = graph.rank;
    const near = new Set<string>();
    for (const f of focus ?? []) {
      const rel = path.isAbsolute(f) ? path.relative(this.root, f).split(path.sep).join("/") : f;
      if (!this.files.has(rel)) continue;
      near.add(rel);
      for (const t of graph.imports.get(rel) ?? []) near.add(t);
      for (const t of graph.importers.get(rel) ?? []) near.add(t);
    }
    return (doc: Doc) => {
      const file = doc.file.p;
      const r = rank.get(file) ?? 1;
      // Code many places use is more likely the code being asked about.
      const users = doc.decl ? graph.usedBy(file, memberName(doc.decl)).length : 0;
      return (1 + 0.12 * Math.log(1 + r)) * (1 + 0.1 * Math.log(1 + users)) * (near.has(file) ? 1.6 : 1);
    };
  }

  /** Ranked declarations and files for a question, one line each. */
  findHits(question: string, opts: FindOptions = {}): Hit[] {
    this.load();
    return this.search.search(question, this.boostFor(opts.focus), 80);
  }

  find(question: string, opts: FindOptions = {}): string {
    this.load();
    if (!this.files.size) return "The code map is still being built. Try again in a few seconds, or search the usual way.";
    const budget = opts.budget ?? 300;
    const limit = opts.limit ?? 10;
    const hits = this.findHits(question, opts);
    if (!hits.length) return `Nothing in the code map matches "${question}". Search the usual way (grep), or try other words.`;
    const lines: string[] = [];
    const perFile = new Map<string, number>();
    let used = 0;
    for (const h of hits) {
      if (lines.length >= limit) break;
      const n = perFile.get(h.doc.file.p) ?? 0;
      if (n >= 3) continue;
      const line = this.hitLine(h);
      const cost = tokensOf(line) + 1;
      if (used + cost > budget && lines.length) break;
      lines.push(line);
      used += cost;
      perFile.set(h.doc.file.p, n + 1);
    }
    return lines.join("\n");
  }

  private hitLine(h: Hit): string {
    const f = h.doc.file;
    const d = h.doc.decl;
    if (!d) return `${f.p}  (file, ${f.n} lines)`;
    const users = this.graph.usedBy(f.p, memberName(d)).length;
    const name = d.p ? `${d.p}.${d.n}` : d.n;
    const parts = [`${name}  ${d.route ?? d.k}  ${f.p}:${d.s}-${d.e}`];
    if (users) parts.push(`used by ${users}`);
    if (d.d) parts.push(d.d.length > 70 ? `${d.d.slice(0, 69)}…` : d.d);
    return parts.join("  · ");
  }

  /** One level of a folder, a file or a symbol. */
  outline(target: string, budget = 600): string {
    this.load();
    const t = target.trim().replace(/^\.\//, "").replace(/\/$/, "");
    const rel = path.isAbsolute(t) ? path.relative(this.root, t).split(path.sep).join("/") : t;
    const file = this.files.get(rel);
    if (file) return this.fileOutline(file, budget);
    const prefix = rel === "" || rel === "." ? "" : `${rel}/`;
    const inFolder = [...this.files.values()].filter((f) => f.p.startsWith(prefix));
    if (inFolder.length) return this.folderOutline(prefix, inFolder, budget);
    const sym = this.symbolHits(t);
    if (sym.length) return this.symbolOutline(sym, budget);
    return `Nothing called "${target}" in the code map: not a file, folder or symbol. crosstalk_map with find searches by words.`;
  }

  private symbolHits(name: string): { file: FileEntry; decl: Decl }[] {
    const [a, b] = name.includes(".") && !name.includes("/") ? name.split(".", 2) : [undefined, name];
    const out: { file: FileEntry; decl: Decl }[] = [];
    for (const f of this.files.values()) {
      for (const d of f.d) if (d.n === b && (!a || d.p === a)) out.push({ file: f, decl: d });
    }
    return out.sort((x, y) => Number(isLowValuePath(x.file.p)) - Number(isLowValuePath(y.file.p)) || (this.graph.rank.get(y.file.p) ?? 0) - (this.graph.rank.get(x.file.p) ?? 0));
  }

  private signature(file: FileEntry, d: Decl): string {
    // Read from the file itself: always current, and never stored twice.
    try {
      const text = fs.readFileSync(path.join(this.root, file.p), "utf8");
      const lines = text.split("\n").slice(d.s - 1, Math.min(d.e, d.s + 3));
      let sig = "";
      for (const l of lines) {
        sig += ` ${l.trim()}`;
        if (/[{:]\s*$|=>\s*[({]?\s*$|\)\s*$/.test(l) || sig.length > 140) break;
      }
      sig = sig.replace(/\s+/g, " ").trim().replace(/\s*[{(]\s*$/, "");
      return sig.length > 150 ? `${sig.slice(0, 149)}…` : sig;
    } catch {
      return `${d.k} ${d.n}`;
    }
  }

  private fileOutline(f: FileEntry, budget: number): string {
    const out: string[] = [`${f.p}  ${f.n} lines`];
    const top = f.d.filter((d) => !d.p || d.k === "method");
    let used = tokensOf(out[0]);
    for (const d of top) {
      const line = `  ${d.s}-${d.e}  ${d.p ? "  " : ""}${this.signature(f, d)}${d.x ? "" : "  (not exported)"}`;
      if (used + tokensOf(line) > budget * 0.7) {
        out.push(`  … ${top.length - (out.length - 1)} more declarations`);
        break;
      }
      out.push(line);
      used += tokensOf(line);
    }
    const imports = [...(this.graph.imports.get(f.p) ?? [])];
    const importers = [...(this.graph.importers.get(f.p) ?? [])].sort((a, b) => (this.graph.rank.get(b) ?? 0) - (this.graph.rank.get(a) ?? 0));
    if (imports.length) out.push(`imports: ${listShort(imports, 6)}`);
    if (importers.length) out.push(`imported by ${importers.length}: ${listShort(importers, 6)}`);
    return out.join("\n");
  }

  private folderOutline(prefix: string, files: FileEntry[], budget: number): string {
    const sub = new Map<string, FileEntry[]>();
    const here: FileEntry[] = [];
    for (const f of files) {
      const rest = f.p.slice(prefix.length);
      const i = rest.indexOf("/");
      if (i < 0) here.push(f);
      else {
        const dir = rest.slice(0, i);
        let list = sub.get(dir);
        if (!list) sub.set(dir, (list = []));
        list.push(f);
      }
    }
    const rank = (f: FileEntry) => this.graph.rank.get(f.p) ?? 0;
    const out = [`${prefix || "./"}  ${files.length} files`];
    const mod = this.modules().find((m) => `${m.id}/` === prefix) ?? (prefix && fs.existsSync(docPath(this.root, prefix.slice(0, -1))) ? this.moduleOrFolder(prefix.slice(0, -1)) : undefined);
    let doc: string | undefined;
    if (mod) {
      if (mod.dependsOn.length) out.push(`uses: ${mod.dependsOn.join(", ")}`);
      const conv = conventionLines(this.conventions(mod.id).filter((c) => c.share >= 0.6).slice(0, 3));
      if (conv.length) out.push(`conventions: ${conv.join("; ")}`);
      const md = this.moduleDoc(mod.id);
      doc = md ? serveModuleDoc(md, (n) => this.nameExists(n)) : undefined;
    }
    let used = tokensOf(out.join("\n"));
    const dirs = [...sub.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [dir, list] of dirs) {
      const best = [...list].sort((a, b) => rank(b) - rank(a))[0];
      const line = `  ${dir}/  ${list.length} files · e.g. ${best.p.slice(prefix.length + dir.length + 1)}`;
      if (used + tokensOf(line) > budget * 0.6) {
        out.push(`  … ${dirs.length - (out.length - 1)} more folders`);
        break;
      }
      out.push(line);
      used += tokensOf(line);
    }
    for (const f of [...here].sort((a, b) => rank(b) - rank(a))) {
      const names = f.d.filter((d) => d.x && !d.p).slice(0, 4).map((d) => d.n);
      const line = `  ${f.p.slice(prefix.length)}  ${f.n} lines${names.length ? ` · ${names.join(", ")}` : ""}`;
      if (used + tokensOf(line) > budget) {
        out.push(`  … more files`);
        break;
      }
      out.push(line);
      used += tokensOf(line);
    }
    return doc ? `${out.join("\n")}\n\n${clip(doc, 1500)}` : out.join("\n");
  }

  private symbolOutline(hits: { file: FileEntry; decl: Decl }[], budget: number): string {
    const out: string[] = [];
    let used = 0;
    for (const { file, decl } of hits.slice(0, 3)) {
      const block = [`${file.p}:${decl.s}-${decl.e}  ${decl.route ?? decl.k}  ${this.signature(file, decl)}`];
      if (decl.d) block.push(`  ${decl.d}`);
      const members = file.d.filter((d) => d.p === decl.n);
      if (members.length) block.push(`  members: ${members.slice(0, 12).map((m) => `${m.n} ${m.s}`).join(", ")}${members.length > 12 ? ", …" : ""}`);
      const users = this.graph.usedBy(file.p, memberName(decl));
      if (users.length) block.push(`  used by ${users.length}: ${edgeList(users, "from", 5)}`);
      const uses = this.graph.uses(file.p, memberName(decl));
      if (uses.length) block.push(`  uses: ${edgeList(uses, "to", 6)}`);
      const text = block.join("\n");
      if (used + tokensOf(text) > budget && out.length) break;
      out.push(text);
      used += tokensOf(text);
    }
    if (hits.length > 3) out.push(`(${hits.length - 3} more declarations with this name)`);
    return out.join("\n");
  }

  /** Who uses a symbol or file and what it uses, one or two hops. */
  graphOf(target: string, hops: 1 | 2 = 1, budget = 400): string {
    this.load();
    const t = target.trim().replace(/^\.\//, "");
    const file = this.files.get(t);
    if (file) {
      const importers = [...(this.graph.importers.get(file.p) ?? [])];
      const imports = [...(this.graph.imports.get(file.p) ?? [])];
      const out = [`${file.p}`, `imported by ${importers.length}: ${listShort(importers, 10)}`, `imports ${imports.length}: ${listShort(imports, 10)}`];
      if (hops === 2) {
        const second = new Set<string>();
        for (const i of importers) for (const j of this.graph.importers.get(i) ?? []) if (j !== file.p && !importers.includes(j)) second.add(j);
        out.push(`then imported by ${second.size} more: ${listShort([...second], 8)}`);
      }
      return clip(out.join("\n"), budget);
    }
    const hits = this.symbolHits(t);
    if (!hits.length) return `No file or symbol called "${target}". crosstalk_map with find searches by words.`;
    const { file: f, decl } = hits[0];
    const me = memberName(decl);
    const users = this.graph.usedBy(f.p, me);
    const uses = this.graph.uses(f.p, me);
    const out = [`${me}  ${decl.k}  ${f.p}:${decl.s}-${decl.e}`];
    out.push(users.length ? `used by ${users.length}:\n${edgeLines(users, "from", 12)}` : "used by: nothing found in this codebase (it may be an entry point, or used dynamically)");
    if (hops === 2 && users.length) {
      const second: Edge[] = [];
      const seen = new Set(users.map((u) => `${u.from.file}#${u.from.name}`));
      for (const u of users) {
        for (const e of this.graph.usedBy(u.from.file, u.from.name)) {
          const k = `${e.from.file}#${e.from.name}`;
          if (!seen.has(k)) {
            seen.add(k);
            second.push(e);
          }
        }
      }
      if (second.length) out.push(`and through them, ${second.length} more:\n${edgeLines(second, "from", 8)}`);
    }
    if (uses.length) out.push(`uses ${uses.length}:\n${edgeLines(uses, "to", 10)}`);
    if (hits.length > 1) out.push(`(${hits.length - 1} other declarations named ${decl.n}; name the file to pick one)`);
    return clip(out.join("\n"), budget);
  }

  /** The project card: how to run it, its entry points and its main folders. No prose. */
  overview(budget = 500): string {
    this.load();
    const out: string[] = [];
    const pkg = readJsonFile(path.join(this.root, "package.json")) as { name?: string; scripts?: Record<string, string> } | undefined;
    if (pkg?.scripts) {
      const keep = Object.keys(pkg.scripts).filter((s) => /^(dev|start|build|test|lint|typecheck|check|e2e|format)(:|$)/.test(s)).slice(0, 8);
      if (keep.length) out.push(`commands: ${keep.map((s) => `npm run ${s}`).join(" · ")}`);
    }
    if (fs.existsSync(path.join(this.root, "pyproject.toml"))) out.push("python: pyproject.toml");
    if (fs.existsSync(path.join(this.root, "Makefile"))) {
      try {
        const targets = [...fs.readFileSync(path.join(this.root, "Makefile"), "utf8").matchAll(/^([a-zA-Z][\w-]*):/gm)].map((m) => m[1]).slice(0, 8);
        if (targets.length) out.push(`make: ${targets.join(" · ")}`);
      } catch {
        // No Makefile to read.
      }
    }
    const langs = new Map<string, number>();
    let decls = 0;
    for (const f of this.files.values()) {
      langs.set(f.l, (langs.get(f.l) ?? 0) + 1);
      decls += f.d.length;
    }
    out.push(`${this.files.size} files (${[...langs.entries()].map(([l, n]) => `${n} ${l}`).join(", ")}), ${decls} declarations`);

    const entries: string[] = [];
    const pages = [...this.files.keys()].filter((p) => /^(src\/)?app\/(.+\/)?(page|route|layout)\.(tsx|ts|jsx|js)$|^(src\/)?pages\/.+\.(tsx|jsx|ts|js)$/.test(p));
    if (pages.length) entries.push(`${pages.length} Next.js pages and routes under ${commonDir(pages)}`);
    let routes = 0;
    for (const f of this.files.values()) for (const d of f.d) if (d.k === "route") routes++;
    if (routes) entries.push(`${routes} web routes (find "route" lists them)`);
    for (const m of ["main.py", "app/main.py", "src/main.py", "manage.py", "src/index.ts", "src/main.ts", "index.ts", "src/extension.ts", "server.ts"]) {
      if (this.files.has(m)) entries.push(m);
    }
    if (entries.length) out.push(`entry points: ${entries.join(" · ")}`);

    const mods = this.modules().slice(0, 10);
    if (mods.length) {
      out.push(`main parts (most depended on first):\n${mods.map((m) => `  ${m.id}/  ${m.files.length} files${m.dependsOn.length ? ` · uses ${m.dependsOn[0]}` : ""}`).join("\n")}`);
    }
    const central = [...this.graph.rank.entries()].filter(([p]) => !isLowValuePath(p)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
    if (central.length) out.push(`most imported files: ${central.join(" · ")}`);
    const conv = conventionLines(this.conventions().filter((c) => c.share >= 0.6).slice(0, 3)).map((c) => c.replace(/, e\.g\. ([^,]+), .*$/, ", e.g. $1"));
    if (conv.length) out.push(`conventions:\n${conv.map((c) => `  ${c}`).join("\n")}`);
    const stale = this.staleDocs();
    if (stale.length) out.push(`docs out of date: ${stale.length === 1 ? "1 line names something that is" : `${stale.length} lines name things that are`} gone, e.g. ${stale.slice(0, 2).map((d) => `${d.file}:${d.line} (${d.missing})`).join(", ")}`);
    return clip(out.join("\n"), budget);
  }

  /**
   * Candidates for clean-up: exports nothing in the codebase uses, and files nothing imports. Entry
   * points (pages, routes, configs, tests, scripts) are never listed. Code used by name at run time
   * (dynamic imports, frameworks) can look unused, so each is a candidate to check, not a verdict.
   */
  unused(): { exports: { file: string; decl: Decl }[]; localOnly: { file: string; decl: Decl }[]; files: string[] } {
    this.load();
    const graph = this.graph;
    const entry = (p: string) =>
      isLowValuePath(p) ||
      /(^|\/)(page|layout|route|loading|error|not-found|global-error|template|default|middleware|proxy|instrumentation|instrumentation-client|mdx-components|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)\.(tsx?|jsx?|mdx?)$/.test(p) ||
      /(^|\/)pages\//.test(p) ||
      /\.(config|setup)\.[cm]?[jt]s$|\.d\.ts$|(^|\/)(index|main|server|cli|extension|__init__|__main__|manage|conftest|settings|wsgi|asgi)\.[a-z]+$/.test(p);
    const candidates: { file: string; decl: Decl }[] = [];
    const files: string[] = [];
    for (const f of this.files.values()) {
      if (entry(f.p)) continue;
      if (!(graph.importers.get(f.p)?.size) && f.l !== "python") {
        files.push(f.p);
        continue;
      }
      for (const d of f.d) {
        if (!d.x || d.p || d.k === "route" || d.n === "default" || d.n === f.def) continue;
        if (/^(metadata|generateMetadata|generateStaticParams|revalidate|dynamic|runtime|config|viewport)$/.test(d.n)) continue;
        if (graph.usedBy(f.p, d.n).length) continue;
        candidates.push({ file: f.p, decl: d });
      }
    }
    // A last plain-text pass over the codebase: any mention outside its own file counts as a use the
    // graph couldn't see (property access, strings, a framework calling it by name).
    const names = new Set(candidates.map((c) => c.decl.n));
    const seenIn = new Map<string, Set<string>>();
    const ownCount = new Map<string, number>();
    for (const f of this.files.values()) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.root, f.p), "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const w = m[0];
        if (!names.has(w)) continue;
        let set = seenIn.get(w);
        if (!set) seenIn.set(w, (set = new Set()));
        set.add(f.p);
        const k = `${f.p}#${w}`;
        ownCount.set(k, (ownCount.get(k) ?? 0) + 1);
      }
    }
    const exports: { file: string; decl: Decl }[] = [];
    const localOnly: { file: string; decl: Decl }[] = [];
    for (const c of candidates) {
      const where = seenIn.get(c.decl.n) ?? new Set();
      if ([...where].some((p) => p !== c.file)) continue;
      if ((ownCount.get(`${c.file}#${c.decl.n}`) ?? 0) > 1) localOnly.push(c);
      else exports.push(c);
    }
    return { exports, localOnly, files: files.sort() };
  }

  unusedText(budget = 600): string {
    const { exports, localOnly, files } = this.unused();
    const out = ["Candidates: checked by imports and by name across the codebase, but code loaded by name at run time can still look unused."];
    out.push(`files nothing imports (${files.length}): ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}`);
    out.push(`unused anywhere (${exports.length}):`);
    for (const e of exports.slice(0, 30)) out.push(`  ${e.decl.n}  ${e.decl.k}  ${e.file}:${e.decl.s}-${e.decl.e}`);
    if (localOnly.length) out.push(`exported but used only in their own file, so the export can go (${localOnly.length}): ${localOnly.slice(0, 15).map((e) => `${e.decl.n} (${e.file})`).join(", ")}${localOnly.length > 15 ? ", …" : ""}`);
    return clip(out.join("\n"), budget);
  }

  /** Words that would find this file: used by the replay benchmark and the Board. */
  static words = words;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function commonDir(paths: string[]): string {
  const split = paths.map((p) => p.split("/"));
  const first = split[0] ?? [];
  let i = 0;
  while (i < first.length - 1 && split.every((s) => s[i] === first[i])) i++;
  return `${first.slice(0, i).join("/") || "."}/`;
}

function listShort(items: string[], n: number): string {
  return items.length > n ? `${items.slice(0, n).join(", ")}, … ${items.length - n} more` : items.join(", ");
}

const CONF_MARK: Record<Confidence, string> = { found: "", likely: " (likely)", guessed: " (guessed)" };

function edgeList(edges: Edge[], side: "from" | "to", n: number): string {
  const uniq = dedupe(edges, side);
  return listShort(uniq.map((e) => `${e[side].name}${CONF_MARK[e.conf]}`), n);
}

function edgeLines(edges: Edge[], side: "from" | "to", n: number): string {
  const uniq = dedupe(edges, side);
  const lines = uniq.slice(0, n).map((e) => `  ${e[side].name}  ${e[side].file}${CONF_MARK[e.conf]}`);
  if (uniq.length > n) lines.push(`  … ${uniq.length - n} more`);
  return lines.join("\n");
}

function dedupe(edges: Edge[], side: "from" | "to"): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e[side].file}#${e[side].name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function clip(text: string, budget: number): string {
  const max = budget * 4;
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 20);
  return `${text.slice(0, cut > 0 ? cut : max - 20)}\n… (cut to fit; ask about one part for more)`;
}
