// Turns an import as written ("./x", "@/lib/y", "app.core.db") into a file of this codebase.
import * as fs from "node:fs";
import * as path from "node:path";

interface Alias {
  /** The pattern's text before its `*` ("@/" for "@/*"), or the whole name for an exact alias */
  prefix: string;
  wildcard: boolean;
  /** Folders or files (relative to the root) it points to, with `*` already cut off */
  targets: string[];
}

export interface Resolver {
  isLocal(source: string): boolean;
  resolve(fromFile: string, source: string): string | undefined;
}

/** Reads JSON with comments and trailing commas (tsconfig.json is JSONC). */
export function readJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface CompilerPaths {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

function readTsconfig(file: string, depth = 0): { base: string; opts: CompilerPaths } | undefined {
  try {
    const json = readJsonc(fs.readFileSync(file, "utf8")) as { extends?: string | string[]; compilerOptions?: CompilerPaths };
    const dir = path.dirname(file);
    let inherited: { base: string; opts: CompilerPaths } | undefined;
    const ext = Array.isArray(json.extends) ? json.extends[0] : json.extends;
    if (ext && depth < 3 && (ext.startsWith(".") || ext.startsWith("/"))) {
      const target = path.resolve(dir, ext.endsWith(".json") ? ext : `${ext}.json`);
      inherited = readTsconfig(target, depth + 1);
    }
    const own = json.compilerOptions ?? {};
    // paths are relative to baseUrl if set, else to the file that declares them.
    const declaringDir = own.paths ? dir : inherited?.base ?? dir;
    return {
      base: own.baseUrl ? path.resolve(dir, own.baseUrl) : declaringDir,
      opts: { baseUrl: own.baseUrl ?? inherited?.opts.baseUrl, paths: own.paths ?? inherited?.opts.paths },
    };
  } catch {
    return undefined;
  }
}

const TS_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const INDEX = TS_EXTS.map((e) => `/index${e}`);

export function makeResolver(root: string, files: Set<string>): Resolver {
  const aliases: Alias[] = [];
  let baseUrl: string | undefined;
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const cfg = readTsconfig(path.join(root, name));
    if (!cfg) continue;
    const rel = (p: string) => path.relative(root, path.resolve(cfg.base, p)).split(path.sep).join("/");
    if (cfg.opts.baseUrl) baseUrl = rel(".");
    for (const [pattern, targets] of Object.entries(cfg.opts.paths ?? {})) {
      const local = targets.filter((t) => !t.includes("node_modules"));
      if (!local.length) continue;
      const wildcard = pattern.endsWith("*");
      aliases.push({
        prefix: wildcard ? pattern.slice(0, -1) : pattern,
        wildcard,
        targets: local.map((t) => rel(t.replace(/\*$/, "")).replace(/^$/, ".")),
      });
    }
    break;
  }
  aliases.sort((a, b) => b.prefix.length - a.prefix.length);

  const topDirs = new Set<string>();
  const pyRoots = new Set<string>([""]);
  for (const f of files) {
    const i = f.indexOf("/");
    if (i > 0) topDirs.add(f.slice(0, i));
    if (f.startsWith("src/") && f.endsWith(".py")) pyRoots.add("src/");
  }

  // ---- Go, Rust, Java, PHP, Ruby, C#
  let goModule: string | undefined;
  try {
    goModule = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(root, "go.mod"), "utf8"))?.[1];
  } catch {
    // Not a Go module.
  }
  const byDir = new Map<string, string[]>();
  const byBase = new Map<string, string[]>();
  for (const f of [...files].sort()) {
    const d = path.posix.dirname(f);
    let list = byDir.get(d);
    if (!list) byDir.set(d, (list = []));
    list.push(f);
    const b = path.posix.basename(f);
    let bl = byBase.get(b);
    if (!bl) byBase.set(b, (bl = []));
    bl.push(f);
  }
  /** A file whose path ends with these segments (Java and PHP packages mirror folders). */
  const bySuffix = (segs: string[], ext: string): string | undefined => {
    const base = `${segs[segs.length - 1]}${ext}`;
    const cands = byBase.get(base) ?? [];
    for (let keep = segs.length; keep >= 1; keep--) {
      const tail = `${segs.slice(segs.length - keep).join("/")}${ext}`;
      const hit = cands.filter((c) => c === tail || c.endsWith(`/${tail}`));
      if (hit.length === 1 || (hit.length > 1 && keep >= 2)) return hit[0];
    }
    return undefined;
  };
  const hasCs = [...files].some((f) => f.endsWith(".cs"));
  const goPackageFile = (dir: string) => (byDir.get(dir || ".") ?? []).find((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  const rustRoot = (from: string): string => {
    let d = path.posix.dirname(from);
    while (true) {
      if (files.has(`${d === "." ? "" : `${d}/`}lib.rs`) || files.has(`${d === "." ? "" : `${d}/`}main.rs`)) return d;
      const up = path.posix.dirname(d);
      if (up === d) return "src";
      d = up;
    }
  };
  const rustModuleFile = (segs: string[], base: string): string | undefined => {
    for (let n = segs.length; n >= 0; n--) {
      const rel = segs.slice(0, n).join("/");
      const stem = join(base, rel);
      if (!n) {
        const top = ["lib.rs", "main.rs"].map((x) => join(base, x)).find((x) => files.has(x));
        if (top) return top;
        continue;
      }
      if (files.has(`${stem}.rs`)) return `${stem}.rs`;
      if (files.has(`${stem}/mod.rs`)) return `${stem}/mod.rs`;
    }
    return undefined;
  };

  const join = (...parts: string[]) => path.posix.normalize(parts.filter((p) => p && p !== ".").join("/")).replace(/^\.\//, "");

  const tryTs = (base: string): string | undefined => {
    const clean = base.replace(/\/$/, "");
    if (files.has(clean)) return clean;
    // `./x.js` in TS source means `./x.ts`.
    const noJs = clean.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const ext of TS_EXTS) if (files.has(noJs + ext)) return noJs + ext;
    for (const ix of INDEX) if (files.has(clean + ix)) return clean + ix;
    return undefined;
  };

  const tryPy = (dotted: string, from?: string): string | undefined => {
    const rel = dotted.split(".").join("/");
    const bases = from !== undefined ? [from] : [...pyRoots];
    for (const b of bases) {
      for (const cand of [`${join(b, rel)}.py`, join(b, rel, "__init__.py")]) if (files.has(cand)) return cand;
    }
    return undefined;
  };

  return {
    isLocal(source: string): boolean {
      if (source.startsWith(".") || source.startsWith("/")) return true;
      if (goModule && (source === goModule || source.startsWith(`${goModule}/`))) return true;
      if (/^(crate|self|super)(::|$)/.test(source)) return true;
      if (source.includes("\\")) return !!bySuffix(source.split("\\").slice(1), ".php");
      if (/^[a-z][\w]*(\.[\w]+)+$/.test(source) && /\.[A-Z]\w*$/.test(source)) return !!bySuffix(source.split("."), ".java");
      if (hasCs && /^[A-Z]\w*(\.[A-Z]\w*)*$/.test(source)) {
        // A C# namespace: local when some folder of the codebase is named like its parts.
        const segs = source.split(".");
        return [...byDir.keys()].some((d) => segs.some((seg) => d.split("/").includes(seg)));
      }
      if (aliases.some((a) => (a.wildcard ? source.startsWith(a.prefix) : source === a.prefix))) return true;
      const first = source.split(/[/.]/)[0];
      if (baseUrl !== undefined && topDirs.has(first)) return true;
      // Python: a top-level package of this codebase.
      return topDirs.has(first) || files.has(`${first}.py`) || topDirs.has(`src/${first}`) || files.has(`src/${first}.py`);
    },

    resolve(fromFile: string, source: string): string | undefined {
      const fromDir = path.posix.dirname(fromFile);
      const ext = path.posix.extname(fromFile);
      if (ext === ".go") {
        if (!goModule || !(source === goModule || source.startsWith(`${goModule}/`))) return undefined;
        return goPackageFile(source === goModule ? "" : source.slice(goModule.length + 1));
      }
      if (ext === ".rs") {
        const segs = source.split("::").filter(Boolean);
        const base = rustRoot(fromFile);
        if (segs[0] === "crate") return rustModuleFile(segs.slice(1), base);
        // self:: is this file's module; super:: its parent.
        const stem = /(^|\/)(mod|lib|main)\.rs$/.test(fromFile) ? fromDir : join(fromDir, path.posix.basename(fromFile, ".rs"));
        const rel = path.posix.relative(base === "." ? "" : base, stem);
        let mod = rel ? rel.split("/") : [];
        let i = 0;
        for (; i < segs.length && (segs[i] === "self" || segs[i] === "super"); i++) if (segs[i] === "super") mod = mod.slice(0, -1);
        return rustModuleFile([...mod, ...segs.slice(i)], base);
      }
      if (ext === ".java") {
        const segs = source.split(".");
        return /^[A-Z]/.test(segs[segs.length - 1]) ? bySuffix(segs, ".java") : undefined;
      }
      if (ext === ".php") return bySuffix(source.split("\\").slice(1).length ? source.split("\\").slice(1) : source.split("\\"), ".php");
      if (ext === ".rb") {
        const rel = source.replace(/\.rb$/, "");
        const cands = rel.startsWith(".") ? [join(fromDir, `${rel}.rb`)] : [`lib/${rel}.rb`, `${rel}.rb`, `app/${rel}.rb`];
        return cands.find((c) => files.has(c));
      }
      if (ext === ".cs") return undefined;
      if (fromFile.endsWith(".py")) {
        const m = /^(\.+)(.*)$/.exec(source);
        if (m) {
          let dir = fromDir;
          for (let i = 1; i < m[1].length; i++) dir = path.posix.dirname(dir);
          if (!m[2]) return files.has(join(dir, "__init__.py")) ? join(dir, "__init__.py") : undefined;
          return tryPy(m[2], dir === "." ? "" : dir);
        }
        return tryPy(source);
      }
      if (source.startsWith(".")) return tryTs(join(fromDir, source));
      if (source.startsWith("/")) return tryTs(source.slice(1));
      for (const a of aliases) {
        if (a.wildcard ? !source.startsWith(a.prefix) : source !== a.prefix) continue;
        const rest = a.wildcard ? source.slice(a.prefix.length) : "";
        for (const t of a.targets) {
          const hit = tryTs(join(t, rest));
          if (hit) return hit;
        }
      }
      if (baseUrl !== undefined) return tryTs(join(baseUrl, source));
      return undefined;
    },
  };
}
