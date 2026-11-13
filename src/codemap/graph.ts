// Who imports and calls what, resolved through imports and re-exports, each link marked by how sure
// it is: found (traced through an import to a declaration), likely (through a re-export or a
// Python package), guessed (a name with one declaration, its import unresolved).
import type { Decl } from "./extract";
import type { Resolver } from "./resolve";
import type { FileEntry } from "./store";

export type Confidence = "found" | "likely" | "guessed";

export interface SymbolRef {
  file: string;
  name: string;
}

export interface Edge {
  from: SymbolRef;
  to: SymbolRef;
  conf: Confidence;
}

const key = (r: SymbolRef) => `${r.file}#${r.name}`;

export class CodeGraph {
  /** file → files it imports (resolved) */
  readonly imports = new Map<string, Set<string>>();
  /** file → files that import it */
  readonly importers = new Map<string, Set<string>>();
  /** "file#name" → who uses it */
  readonly callers = new Map<string, Edge[]>();
  /** "file#name" → what it uses */
  readonly callees = new Map<string, Edge[]>();
  /** name → where it's declared (top level only) */
  readonly declared = new Map<string, SymbolRef[]>();
  rank = new Map<string, number>();

  constructor(
    private files: Map<string, FileEntry>,
    private resolver: Resolver,
  ) {
    for (const f of files.values()) {
      for (const d of f.d) {
        if (d.p) continue;
        let list = this.declared.get(d.n);
        if (!list) this.declared.set(d.n, (list = []));
        list.push({ file: f.p, name: d.n });
      }
    }
    for (const f of files.values()) {
      const targets = new Set<string>();
      for (const imp of f.i) {
        const t = this.resolveImport(f.p, imp.s);
        if (t && t !== f.p) targets.add(t);
      }
      this.imports.set(f.p, targets);
      for (const t of targets) {
        let s = this.importers.get(t);
        if (!s) this.importers.set(t, (s = new Set()));
        s.add(f.p);
      }
    }
    for (const f of files.values()) {
      for (const d of f.d) {
        if (!d.r) continue;
        const from = { file: f.p, name: memberName(d) };
        for (const r of d.r) {
          const hit = this.resolveRef(f, r);
          if (!hit) continue;
          const edge: Edge = { from, to: hit.to, conf: hit.conf };
          push(this.callers, key(hit.to), edge);
          push(this.callees, key(from), edge);
        }
      }
    }
    this.rank = pageRank(files, this.imports, this.callers);
  }

  private importCache = new Map<string, string | undefined>();

  resolveImport(fromFile: string, source: string): string | undefined {
    const k = `${fromFile}\0${source}`;
    if (this.importCache.has(k)) return this.importCache.get(k);
    const r = this.resolver.isLocal(source) ? this.resolver.resolve(fromFile, source) : undefined;
    this.importCache.set(k, r);
    return r;
  }

  /** Where `name`, as exported by `file`, is really declared: through re-exports and package files. */
  declaringFile(file: string, name: string, depth = 0, viaReexport = false): { file: string; name: string; conf: Confidence } | undefined {
    const f = this.files.get(file);
    if (!f || depth > 4) return undefined;
    if (name === "default" && f.def) return this.declaringFile(file, f.def, depth, viaReexport);
    if (f.d.some((d) => !d.p && d.n === name)) return { file, name, conf: viaReexport ? "likely" : "found" };
    // A Go package is a folder: what one file imports, every file of the folder declares.
    if (file.endsWith(".go")) {
      const dir = file.slice(0, file.lastIndexOf("/") + 1);
      for (const ref of this.declared.get(name) ?? []) if (ref.file.endsWith(".go") && ref.file.startsWith(dir) && !ref.file.slice(dir.length).includes("/")) return { file: ref.file, name, conf: "found" };
    }
    const py = file.endsWith(".py");
    for (const imp of f.i) {
      if (!imp.re && !py) continue;
      const names = imp.n ?? [];
      const exposed = Object.entries(imp.as ?? {}).find(([, alias]) => alias === name)?.[0] ?? (names.includes(name) ? name : undefined);
      if (!exposed && !names.includes("*")) continue;
      const target = this.resolveImport(file, imp.s);
      if (!target) continue;
      const hit = this.declaringFile(target, exposed ?? name, depth + 1, true);
      if (hit) return hit;
    }
    return undefined;
  }

  private resolveRef(f: FileEntry, ref: string): { to: SymbolRef; conf: Confidence } | undefined {
    const dot = ref.indexOf(".");
    if (dot > 0) {
      const ns = ref.slice(0, dot);
      const name = ref.slice(dot + 1);
      for (const imp of f.i) {
        const n = imp.n ?? [];
        const bound = imp.as?.["*"] === ns || imp.as?.default === ns;
        let target: string | undefined;
        if (bound) target = this.resolveImport(f.p, imp.s);
        else if (n.includes(ns) || Object.values(imp.as ?? {}).includes(ns)) {
          // Python: `from app import billing` then billing.charge()
          const orig = Object.entries(imp.as ?? {}).find(([, a]) => a === ns)?.[0] ?? ns;
          target = this.resolveImport(f.p, `${imp.s}${imp.s.endsWith(".") ? "" : "."}${orig}`);
        }
        if (!target) continue;
        const hit = this.declaringFile(target, name);
        if (hit) return { to: { file: hit.file, name: hit.name }, conf: hit.conf };
      }
      return undefined;
    }
    if (f.d.some((d) => d.n === ref)) {
      const own = f.d.find((d) => d.n === ref)!;
      return { to: { file: f.p, name: memberName(own) }, conf: "found" };
    }
    // Languages that use code without importing it by name (a Go package, Java's own package, C#
    // namespaces, Ruby's and PHP's autoloading): a name declared once nearby, or once at all.
    const open = /\.(go|java|cs|rb|php|rs)$/.test(f.p);
    const nearby = (): { to: SymbolRef; conf: Confidence } | undefined => {
      const cands = (this.declared.get(ref) ?? []).filter((c) => c.file !== f.p);
      if (!cands.length) return undefined;
      const dir = f.p.slice(0, f.p.lastIndexOf("/") + 1);
      const same = cands.filter((c) => c.file.startsWith(dir) && !c.file.slice(dir.length).includes("/"));
      if (same.length === 1) return { to: same[0], conf: f.p.endsWith(".go") ? "found" : "likely" };
      if (cands.length === 1) return { to: cands[0], conf: "guessed" };
      return undefined;
    };
    for (const imp of f.i) {
      const names = imp.n ?? [];
      const orig = names.find((n) => (imp.as?.[n] ?? n) === ref);
      if (!orig) continue;
      const target = this.resolveImport(f.p, imp.s);
      if (target) {
        const hit = this.declaringFile(target, orig);
        if (hit) return { to: { file: hit.file, name: hit.name }, conf: hit.conf };
        // Python `from app import billing` imports a module: the module itself is the target.
        const asModule = this.resolveImport(f.p, `${imp.s}${imp.s.endsWith(".") ? "" : "."}${orig}`);
        if (asModule) return undefined;
      }
      const only = this.declared.get(orig === "default" ? ref : orig);
      if (only && only.length === 1) return { to: only[0], conf: "guessed" };
      return open ? nearby() : undefined;
    }
    return open ? nearby() : undefined;
  }

  usedBy(file: string, name: string): Edge[] {
    return this.callers.get(`${file}#${name}`) ?? [];
  }

  uses(file: string, name: string): Edge[] {
    return this.callees.get(`${file}#${name}`) ?? [];
  }
}

/** Methods are named Class.method in the graph, so two classes' `render` stay apart. */
export function memberName(d: Decl): string {
  return d.p ? `${d.p}.${d.n}` : d.n;
}

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  let list = m.get(k);
  if (!list) m.set(k, (list = []));
  list.push(v);
}

/** PageRank over files: a file many important files import, or whose symbols they use, ranks high. */
function pageRank(files: Map<string, FileEntry>, imports: Map<string, Set<string>>, callers: Map<string, Edge[]>): Map<string, number> {
  const ids = [...files.keys()];
  const index = new Map(ids.map((p, i) => [p, i]));
  const n = ids.length;
  if (!n) return new Map();
  const out: Map<number, number>[] = ids.map(() => new Map());
  for (const [from, targets] of imports) {
    const i = index.get(from);
    if (i === undefined) continue;
    for (const t of targets) {
      const j = index.get(t);
      if (j !== undefined) out[i].set(j, (out[i].get(j) ?? 0) + 1);
    }
  }
  for (const edges of callers.values()) {
    for (const e of edges) {
      if (e.from.file === e.to.file) continue;
      const i = index.get(e.from.file);
      const j = index.get(e.to.file);
      if (i !== undefined && j !== undefined) out[i].set(j, (out[i].get(j) ?? 0) + 0.5);
    }
  }
  const totals = out.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  let pr = new Float64Array(n).fill(1 / n);
  const d = 0.85;
  for (let iter = 0; iter < 25; iter++) {
    const next = new Float64Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!totals[i]) {
        dangling += pr[i];
        continue;
      }
      for (const [j, w] of out[i]) next[j] += d * pr[i] * (w / totals[i]);
    }
    const share = (d * dangling) / n;
    for (let i = 0; i < n; i++) next[i] += share;
    pr = next;
  }
  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) result.set(ids[i], pr[i] * n);
  return result;
}
