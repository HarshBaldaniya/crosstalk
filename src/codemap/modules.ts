// The code's main parts, how it names and lays things out, and which doc lines have gone stale.
// All computed from the map: no AI, same answer every run.
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodeGraph } from "./graph";
import { isLowValuePath } from "./search";
import type { FileEntry } from "./store";

// ---------------------------------------------------------------- modules

export interface Module {
  /** Stable id: the folder it's anchored on ("features/brand-hub", "app/api") */
  id: string;
  files: string[];
  /** Sum of its files' graph rank: how much the rest of the code leans on it */
  rank: number;
  /** Share of its imports that stay inside it (1 = self-contained) */
  cohesion: number;
  /** The modules it imports from most */
  dependsOn: string[];
  /** Every module it imports from, with how many imports */
  depCounts?: Record<string, number>;
}

const MIN_FILES = 4;
const SPLIT_OVER = 250;
/** Folders that hold modules rather than being one ("src", "features", "app" ...). */
const CONTAINER = /^(src|lib|libs|app|apps|packages|features|modules|components|shared|services|pkg|internal|server|client|web|backend|frontend|api|core)$/;

/** Anchors each file on a folder: deep enough to be one part of the code, never deeper than needed. */
export function computeModules(files: Iterable<FileEntry>, graph: CodeGraph): Module[] {
  const all = [...files].filter((f) => !isLowValuePath(f.p));
  const anchorOf = new Map<string, string>();

  const assign = (list: FileEntry[], depth: number) => {
    const groups = new Map<string, FileEntry[]>();
    for (const f of list) {
      const parts = f.p.split("/");
      const key = parts.length - 1 > depth ? parts.slice(0, depth + 1).join("/") : parts.slice(0, Math.max(1, parts.length - 1)).join("/") || ".";
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(f);
    }
    for (const [key, g] of groups) {
      const last = key.split("/").pop() ?? key;
      const deeper = g.some((f) => f.p.split("/").length - 1 > depth + 1);
      if (deeper && depth < 5 && (CONTAINER.test(last) || g.length > SPLIT_OVER)) assign(g, depth + 1);
      else for (const f of g) anchorOf.set(f.p, key);
    }
  };
  assign(all, 0);

  // Tiny groups join their parent folder's module, so the list stays readable.
  const counts = new Map<string, number>();
  for (const a of anchorOf.values()) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const [p, a] of anchorOf) {
    if ((counts.get(a) ?? 0) >= MIN_FILES) continue;
    const parent = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : ".";
    anchorOf.set(p, parent);
  }

  const byId = new Map<string, string[]>();
  for (const [p, a] of anchorOf) {
    let list = byId.get(a);
    if (!list) byId.set(a, (list = []));
    list.push(p);
  }
  const modules: Module[] = [];
  for (const [id, list] of byId) {
    let inside = 0;
    let outside = 0;
    const deps = new Map<string, number>();
    let rank = 0;
    for (const p of list) {
      rank += graph.rank.get(p) ?? 0;
      for (const t of graph.imports.get(p) ?? []) {
        const other = anchorOf.get(t);
        if (other === id) inside++;
        else if (other) {
          outside++;
          deps.set(other, (deps.get(other) ?? 0) + 1);
        }
      }
    }
    modules.push({
      id,
      files: list.sort(),
      rank,
      cohesion: inside + outside ? inside / (inside + outside) : 1,
      dependsOn: [...deps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => m),
      depCounts: Object.fromEntries(deps),
    });
  }
  return modules.sort((a, b) => b.rank - a.rank);
}

// ---------------------------------------------------------------- conventions

export interface Convention {
  /** What it's about: "file names", "hooks", "tests" ... */
  topic: string;
  /** The pattern in a few words */
  rule: string;
  /** How many of the files it applies to follow it */
  share: number;
  examples: string[];
}

type Style = "PascalCase" | "camelCase" | "kebab-case" | "snake_case" | "lowercase";

function styleOf(name: string): Style | undefined {
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  if (/^[a-z0-9]+$/.test(name)) return "lowercase";
  return undefined;
}

function majority<T extends string>(items: { key: T; example: string }[]): { key: T; share: number; examples: string[] } | undefined {
  if (items.length < 3) return undefined;
  const counts = new Map<T, string[]>();
  for (const it of items) {
    let list = counts.get(it.key);
    if (!list) counts.set(it.key, (list = []));
    list.push(it.example);
  }
  const [key, examples] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return { key, share: examples.length / items.length, examples: examples.slice(0, 2) };
}

/** Naming, layout and test patterns for a set of files, each with how widely it holds and two real examples. */
export function computeConventions(files: FileEntry[]): Convention[] {
  const out: Convention[] = [];
  const base = (p: string) => (p.split("/").pop() ?? p).replace(/\.(test|spec|stories|story)\.[^.]+$|\.[^.]+$/, "");

  const components = files.filter((f) => f.d.some((d) => d.k === "component" && d.x) && !isLowValuePath(f.p));
  const comp = majority(components.map((f) => ({ key: styleOf(base(f.p)) ?? "lowercase", example: f.p })));
  if (comp) out.push({ topic: "component files", rule: `named in ${comp.key}`, share: comp.share, examples: comp.examples });

  const plain = files.filter((f) => !f.d.some((d) => d.k === "component") && !isLowValuePath(f.p) && f.l !== "python");
  const pl = majority(plain.map((f) => ({ key: styleOf(base(f.p)) ?? "lowercase", example: f.p })));
  if (pl) out.push({ topic: "other files", rule: `named in ${pl.key}`, share: pl.share, examples: pl.examples });

  const hooks = files.flatMap((f) => f.d.filter((d) => d.k === "hook" && d.x && !d.p).map((d) => ({ f, d })));
  if (hooks.length >= 3) {
    const inHooksDir = hooks.filter(({ f }) => /(^|\/)hooks\//.test(f.p));
    const ownFile = hooks.filter(({ f, d }) => base(f.p) === d.n || base(f.p) === d.n.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
    if (inHooksDir.length / hooks.length >= 0.5) out.push({ topic: "hooks", rule: "live in a hooks/ folder", share: inHooksDir.length / hooks.length, examples: inHooksDir.slice(0, 2).map(({ f, d }) => `${d.n} in ${f.p}`) });
    if (ownFile.length / hooks.length >= 0.5) out.push({ topic: "hooks", rule: "one per file, file named after the hook", share: ownFile.length / hooks.length, examples: ownFile.slice(0, 2).map(({ f }) => f.p) });
  }

  const tests = files.filter((f) => /\.(test|spec)\.[^.]+$|(^|\/)test_[^/]+\.py$|_test\.py$/.test(f.p));
  if (tests.length >= 3) {
    const where = majority(
      tests.map((f) => ({
        key: /(^|\/)__tests__\//.test(f.p)
          ? "in __tests__ folders"
          : /^(tests?|e2e|specs?|cypress|playwright)\//.test(f.p)
            ? `in a top-level ${f.p.split("/")[0]}/ folder`
            : "next to the code they test",
        example: f.p,
      })),
    );
    if (where) out.push({ topic: "tests", rule: where.key, share: where.share, examples: where.examples });
  }

  const stories = files.filter((f) => /\.stories\.[^.]+$/.test(f.p));
  if (stories.length >= 3) out.push({ topic: "stories", rule: "Storybook stories next to components (*.stories.tsx)", share: 1, examples: stories.slice(0, 2).map((f) => f.p) });

  const exports = files.flatMap((f) => f.d.filter((d) => !d.p && (d.k === "function" || d.k === "component" || d.k === "hook")));
  if (exports.length >= 10) {
    const named = exports.filter((d) => d.x);
    out.push({ topic: "exports", rule: `${Math.round((100 * named.length) / exports.length)}% of functions are exported`, share: named.length / exports.length, examples: [] });
  }

  const py = files.filter((f) => f.l === "python" && !isLowValuePath(f.p));
  const pyf = majority(py.map((f) => ({ key: styleOf(base(f.p)) ?? "lowercase", example: f.p })));
  if (pyf) out.push({ topic: "python files", rule: `named in ${pyf.key}`, share: pyf.share, examples: pyf.examples });

  return out;
}

export function conventionLines(conv: Convention[]): string[] {
  return conv.map((c) => `${c.topic}: ${c.rule} (${Math.round(c.share * 100)}%)${c.examples.length ? `, e.g. ${c.examples.join(", ")}` : ""}`);
}

// ---------------------------------------------------------------- docs check

export interface StaleDocLine {
  file: string;
  line: number;
  /** What the line names that no longer exists */
  missing: string;
  kind: "file" | "symbol" | "script";
}

const DOC_FILES = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|CLAUDE|AGENTS|GEMINI)\.md$|^docs\/.+\.md$/i;
const MAX_DOCS = 60;

/**
 * Doc lines that name a file, a symbol or an npm script that no longer exists. Only names written as
 * code (`like.this`) are checked, so prose is never misread.
 */
export function checkDocs(root: string, files: Map<string, FileEntry>, allPaths: Set<string>): StaleDocLine[] {
  const docs: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 3 || docs.length >= MAX_DOCS) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if ((depth === 0 && it.name === "docs") || (depth > 0 && rel.startsWith("docs"))) walk(path.join(dir, it.name), r, depth + 1);
      } else if (it.isFile() && DOC_FILES.test(r)) docs.push(r);
    }
  };
  walk(root, "", 0);

  const names = new Set<string>();
  for (const f of files.values()) for (const d of f.d) names.add(d.n);
  let scripts: Set<string> | undefined;
  try {
    scripts = new Set(Object.keys((JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}));
  } catch {
    scripts = undefined;
  }
  const exts = /\.(tsx?|jsx?|mjs|cjs|py|json|md|css|sql|ya?ml|toml|sh)$/;

  const out: StaleDocLine[] = [];
  for (const doc of docs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, doc), "utf8");
    } catch {
      continue;
    }
    let inFence = false;
    text.split("\n").forEach((line, i) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return;
      for (const m of line.matchAll(/`([^`\n]{2,120})`/g)) {
        const code = m[1].trim();
        const run = /^npm run ([\w:-]+)/.exec(code);
        if (run && scripts && !scripts.has(run[1])) {
          out.push({ file: doc, line: i + 1, missing: code, kind: "script" });
          continue;
        }
        // A path: has a slash and a known extension, no spaces, no globs or placeholders.
        if (/^[\w@.\-/[\]()]+$/.test(code) && code.includes("/") && exts.test(code) && !/[*<>{}]/.test(code) && !/^https?:/.test(code)) {
          const rel = code.replace(/^\.\//, "");
          // A path whose first folder isn't in this repo is about another one (a backend, a library).
          const first = rel.split("/")[0];
          if (!fs.existsSync(path.join(root, first)) && !fs.existsSync(path.join(root, path.posix.dirname(doc), first))) continue;
          const docDir = path.posix.dirname(doc);
          const candidates = [rel, path.posix.normalize(`${docDir}/${rel}`)];
          if (!candidates.some((c) => allPaths.has(c) || fs.existsSync(path.join(root, c)))) out.push({ file: doc, line: i + 1, missing: code, kind: "file" });
          continue;
        }
        // A hook named like `useThing` or `useThing()`: hooks are always the codebase's own, so one that
        // isn't declared anywhere is a stale line. (Other names may be browser or library APIs.)
        const sym = /^(use[A-Z][\w$]{2,})(\(\))?$/.exec(code);
        if (sym && !names.has(sym[1])) {
          out.push({ file: doc, line: i + 1, missing: code, kind: "symbol" });
        }
      }
    });
  }
  return out;
}
