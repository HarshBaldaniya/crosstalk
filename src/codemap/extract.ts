// What one file declares, imports and refers to, read from its syntax tree by code alone.
import { parse, query, type LangId, type SyntaxNode } from "./parser";
import { extractWithTable, type TableLang } from "./langs";

const TABLE_LANGS = new Set<LangId>(["go", "rust", "java", "csharp", "ruby", "php"]);

export type DeclKind =
  | "function"
  | "component"
  | "hook"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "namespace"
  | "route";

export interface Decl {
  /** Name */
  n: string;
  /** Kind */
  k: DeclKind;
  /** First and last line, 1-based */
  s: number;
  e: number;
  /** Exported (or public, for Python) */
  x?: boolean;
  /** The first line of its doc comment */
  d?: string;
  /** The class or namespace it sits in */
  p?: string;
  /** What it uses from this codebase: `name` (a local or imported name) or `ns.name` (via an imported module) */
  r?: string[];
  /** For a web route: "GET /items/{id}" */
  route?: string;
}

export interface Import {
  /** The module as written: "./x", "@/lib/y", "react", "app.core.db", ".models" */
  s: string;
  /** The names taken from it ("default", "*" for a namespace); only kept for this codebase's own modules */
  n?: string[];
  /** The local names they're bound to, where they differ ("default" → "Button") */
  as?: Record<string, string>;
  /** A re-export (`export ... from`) */
  re?: boolean;
}

export interface FileFacts {
  decls: Decl[];
  imports: Import[];
  lines: number;
  /** The name `export default` gives, when it names a declaration */
  def?: string;
}

/** Whether an import names this codebase's own module (decided by the indexer, which knows the aliases). */
export type IsLocal = (source: string) => boolean;

const MAX_REFS = 60;
const MAX_DOC = 120;

const squash = (t: string, max: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const unquote = (t: string) => t.replace(/^[`'"]|[`'"]$/g, "");
const isPascal = (n: string) => /^[A-Z][A-Za-z0-9]*$/.test(n);
const isHook = (n: string) => /^use[A-Z0-9]/.test(n);
const SHOUT = /^[A-Z][A-Z0-9_]+$/;

/** A doc comment directly above a node: its first meaningful line. */
function docAbove(node: SyntaxNode): string | undefined {
  let prev = node.previousNamedSibling;
  if (prev && prev.type === "decorator") prev = prev.previousNamedSibling;
  if (!prev || prev.type !== "comment") return undefined;
  if (node.startPosition.row - prev.endPosition.row > 1) return undefined;
  const lines = prev.text
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/+|#)\s?/, "").replace(/\*\/\s*$/, "").trim())
    .filter((l) => l && !l.startsWith("@") && !/^(eslint|prettier|@ts-|TODO\b|FIXME\b|-{3,}|={3,})/.test(l));
  return lines[0] ? squash(lines[0], MAX_DOC) : undefined;
}

// ---------------------------------------------------------------- TypeScript and JavaScript

const TS_REFS = `
(call_expression function: (identifier) @r)
(call_expression function: (member_expression object: (identifier) @o property: (property_identifier) @r))
(new_expression constructor: (identifier) @r)
(new_expression constructor: (member_expression object: (identifier) @o property: (property_identifier) @r))
(arguments (identifier) @r)
`;
const JSX_REFS = `
(jsx_opening_element name: (identifier) @r)
(jsx_opening_element name: (member_expression object: (identifier) @o property: (property_identifier) @r))
(jsx_self_closing_element name: (identifier) @r)
(jsx_self_closing_element name: (member_expression object: (identifier) @o property: (property_identifier) @r))
(jsx_expression (identifier) @r)
`;
const TS_TYPE_REFS = `(type_identifier) @r`;
const TS_DYNAMIC = `
(call_expression function: (import) arguments: (arguments (string) @s))
(call_expression function: (identifier) @f arguments: (arguments (string) @s) (#eq? @f "require"))
`;

function tsValueKind(name: string, value: SyntaxNode | null, jsx: boolean): DeclKind {
  if (!value) return "const";
  const fnLike = (n: SyntaxNode | null): boolean =>
    !!n && (n.type === "arrow_function" || n.type === "function_expression" || n.type === "function");
  let fn = fnLike(value);
  if (!fn && value.type === "call_expression") {
    // memo(...), forwardRef(...), React.memo(function X() {}), styled.div`...`
    const args = value.childForFieldName("arguments");
    fn = !!args && args.namedChildren.some((a) => fnLike(a));
    if (!fn && isPascal(name) && jsx) return "component";
  }
  if (!fn) return "const";
  if (isHook(name)) return "hook";
  if (isPascal(name) && jsx) return "component";
  return "function";
}

function tsFunctionKind(name: string, jsx: boolean): DeclKind {
  if (isHook(name)) return "hook";
  if (isPascal(name) && jsx) return "component";
  return "function";
}

function tsDecls(root: SyntaxNode, jsx: boolean, isLocal: IsLocal): { decls: Decl[]; imports: Import[]; def?: string } {
  const decls: Decl[] = [];
  const imports: Import[] = [];
  const exportedNames = new Set<string>();
  let def: string | undefined;

  const add = (node: SyntaxNode, n: string, k: DeclKind, exported: boolean, docNode: SyntaxNode, parent?: string) => {
    const d: Decl = { n, k, s: node.startPosition.row + 1, e: node.endPosition.row + 1 };
    if (exported) d.x = true;
    const doc = docAbove(docNode);
    if (doc) d.d = doc;
    if (parent) d.p = parent;
    decls.push(d);
  };

  const importOf = (source: string, names: string[], as: Record<string, string>, re?: boolean) => {
    const imp: Import = { s: source };
    if (isLocal(source)) {
      if (names.length) imp.n = names;
      if (Object.keys(as).length) imp.as = as;
    }
    if (re) imp.re = true;
    imports.push(imp);
  };

  const classBody = (body: SyntaxNode | null, cls: string, exported: boolean) => {
    for (const m of body?.namedChildren ?? []) {
      if (!m) continue;
      if (m.type === "method_definition" || m.type === "method_signature" || m.type === "abstract_method_signature") {
        const name = m.childForFieldName("name")?.text;
        if (name) add(m, name, "method", exported, m, cls);
      } else if (m.type === "public_field_definition") {
        const value = m.childForFieldName("value");
        const name = m.childForFieldName("name")?.text;
        if (name && value && (value.type === "arrow_function" || value.type === "function_expression")) add(m, name, "method", exported, m, cls);
      }
    }
  };

  const visit = (node: SyntaxNode, exported: boolean, docNode: SyntaxNode, parent?: string): void => {
    switch (node.type) {
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        const source = node.childForFieldName("source");
        if (source) {
          const names: string[] = [];
          const as: Record<string, string> = {};
          for (const spec of node.descendantsOfType("export_specifier")) {
            const n = spec?.childForFieldName("name")?.text;
            const alias = spec?.childForFieldName("alias")?.text;
            if (n) names.push(n);
            if (n && alias) as[n] = alias;
          }
          importOf(unquote(source.text), names.length ? names : ["*"], as, true);
          return;
        }
        const isDefault = node.children.some((c) => c?.type === "default");
        if (decl) {
          const name = decl.childForFieldName("name")?.text;
          if (isDefault && name) def = name;
          return visit(decl, true, node, parent);
        }
        const value = node.childForFieldName("value");
        if (value) {
          if (value.type === "identifier") {
            exportedNames.add(value.text);
            if (isDefault) def = value.text;
          }
          else if (value.type === "arrow_function" || value.type === "function_expression" || value.type === "class") {
            add(node, "default", value.type === "class" ? "class" : "function", true, node, parent);
          }
        }
        for (const spec of node.descendantsOfType("export_specifier")) {
          const n = spec?.childForFieldName("name")?.text;
          if (n) exportedNames.add(n);
        }
        return;
      }
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature": {
        const name = node.childForFieldName("name")?.text;
        if (name) add(node, name, tsFunctionKind(name, jsx), exported, docNode, parent);
        return;
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;
        const component = jsx && /extends\s+(React\.)?(Pure)?Component\b/.test(node.text.slice(0, 300));
        add(node, name, component ? "component" : "class", exported, docNode, parent);
        classBody(node.childForFieldName("body"), name, exported);
        return;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        const kind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type";
        if (name) add(node, name, kind, exported, docNode, parent);
        return;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const declarators = node.namedChildren.filter((v): v is SyntaxNode => !!v && v.type === "variable_declarator");
        for (const v of declarators) {
          const nameNode = v.childForFieldName("name");
          if (!nameNode || nameNode.type !== "identifier") continue;
          const name = nameNode.text;
          const kind = tsValueKind(name, v.childForFieldName("value"), jsx);
          // A plain constant is listed only when exported or SHOUTING (config); the rest is noise.
          if (kind === "const" && !exported && !SHOUT.test(name)) continue;
          add(declarators.length === 1 ? node : v, name, kind, exported, docNode, parent);
        }
        return;
      }
      case "internal_module":
      case "module": {
        const name = node.childForFieldName("name")?.text;
        if (!name) return;
        const n = unquote(name);
        add(node, n, "namespace", exported, docNode, parent);
        for (const c of node.childForFieldName("body")?.namedChildren ?? []) if (c) visit(c, exported, c, n);
        return;
      }
      case "ambient_declaration":
        for (const c of node.namedChildren) if (c) visit(c, exported, docNode, parent);
        return;
      case "expression_statement": {
        const c = node.namedChildren[0];
        if (c && c.type === "internal_module") visit(c, exported, docNode, parent);
        return;
      }
      case "import_statement": {
        const source = node.childForFieldName("source");
        if (!source) return;
        const names: string[] = [];
        const as: Record<string, string> = {};
        for (const c of node.descendantsOfType(["import_specifier", "namespace_import", "import_clause"])) {
          if (!c) continue;
          if (c.type === "import_specifier") {
            const n = c.childForFieldName("name")?.text;
            const alias = c.childForFieldName("alias")?.text;
            if (n) names.push(n);
            if (n && alias) as[n] = alias;
          } else if (c.type === "namespace_import") {
            const local = c.namedChildren.find((x) => x?.type === "identifier")?.text;
            names.push("*");
            if (local) as["*"] = local;
          } else {
            const defId = c.namedChildren.find((x) => x?.type === "identifier");
            if (defId) {
              names.push("default");
              as.default = defId.text;
            }
          }
        }
        importOf(unquote(source.text), names, as);
        return;
      }
      default:
        return;
    }
  };

  for (const c of root.namedChildren) if (c) visit(c, false, c);
  if (exportedNames.size) for (const d of decls) if (!d.p && exportedNames.has(d.n)) d.x = true;
  return { decls, imports, def };
}

// ---------------------------------------------------------------- Python

const PY_REFS = `
(call function: (identifier) @r)
(call function: (attribute object: (identifier) @o attribute: (identifier) @r))
(decorator (identifier) @r)
(argument_list (identifier) @r)
(type (identifier) @r)
(keyword_argument value: (identifier) @r)
`;

function pyDocstring(def: SyntaxNode): string | undefined {
  const first = def.childForFieldName("body")?.namedChildren[0];
  if (!first || first.type !== "expression_statement") return undefined;
  const str = first.namedChildren[0];
  if (!str || str.type !== "string") return undefined;
  const line = str.text
    .replace(/^[rubfRUBF]*("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ? squash(line, MAX_DOC) : undefined;
}

const ROUTE = /^@\s*[\w.]*\.(get|post|put|patch|delete|head|options|route|websocket|api_route)\s*\(\s*(?:[rbuf]?["']([^"']*)["'])?/i;

function pyDecls(root: SyntaxNode, isLocal: IsLocal): { decls: Decl[]; imports: Import[] } {
  const decls: Decl[] = [];
  const imports: Import[] = [];

  const add = (span: SyntaxNode, def: SyntaxNode, n: string, k: DeclKind, parent?: string, route?: string) => {
    const d: Decl = { n, k, s: span.startPosition.row + 1, e: span.endPosition.row + 1 };
    if (!n.startsWith("_") || /^__\w+__$/.test(n)) d.x = true;
    const doc = pyDocstring(def) ?? docAbove(span);
    if (doc) d.d = doc;
    if (parent) d.p = parent;
    if (route) d.route = route;
    decls.push(d);
  };

  const visit = (node: SyntaxNode, parent?: string) => {
    let def = node;
    let route: string | undefined;
    if (node.type === "decorated_definition") {
      const inner = node.childForFieldName("definition");
      if (!inner) return;
      def = inner;
      for (const dec of node.namedChildren) {
        if (dec?.type !== "decorator") continue;
        const m = ROUTE.exec(dec.text);
        if (m) route = `${m[1].toUpperCase()}${m[2] !== undefined ? ` ${m[2] || "/"}` : ""}`;
      }
    }
    if (def.type === "function_definition") {
      const name = def.childForFieldName("name")?.text;
      if (name) add(node, def, name, route ? "route" : parent ? "method" : "function", parent, route);
    } else if (def.type === "class_definition") {
      const name = def.childForFieldName("name")?.text;
      if (!name) return;
      add(node, def, name, "class", parent);
      for (const c of def.childForFieldName("body")?.namedChildren ?? []) {
        if (c && (c.type === "function_definition" || c.type === "decorated_definition")) visit(c, name);
      }
    } else if (!parent && node.type === "expression_statement") {
      const a = node.namedChildren[0];
      const left = a?.type === "assignment" ? a.childForFieldName("left") : null;
      if (left?.type === "identifier" && SHOUT.test(left.text)) {
        decls.push({ n: left.text, k: "const", s: node.startPosition.row + 1, e: node.endPosition.row + 1, x: true });
      }
    } else if (!parent && node.type === "import_statement") {
      for (const c of node.namedChildren) {
        const mod = c?.type === "aliased_import" ? c.childForFieldName("name")?.text : c?.type === "dotted_name" ? c.text : undefined;
        if (!mod) continue;
        const alias = c?.type === "aliased_import" ? c.childForFieldName("alias")?.text : undefined;
        const imp: Import = { s: mod };
        if (isLocal(mod)) {
          imp.n = ["*"];
          imp.as = { "*": alias ?? mod.split(".")[0] };
        }
        imports.push(imp);
      }
    } else if (!parent && node.type === "import_from_statement") {
      const modNode = node.childForFieldName("module_name");
      if (!modNode) return;
      const mod = modNode.text;
      const names: string[] = [];
      const as: Record<string, string> = {};
      for (const c of node.namedChildren) {
        if (!c || c.startIndex === modNode.startIndex) continue;
        if (c.type === "dotted_name") names.push(c.text);
        else if (c.type === "aliased_import") {
          const n = c.childForFieldName("name")?.text;
          const alias = c.childForFieldName("alias")?.text;
          if (n) names.push(n);
          if (n && alias) as[n] = alias;
        } else if (c.type === "wildcard_import") names.push("*");
      }
      const imp: Import = { s: mod };
      if (isLocal(mod)) {
        imp.n = names.length ? names : ["*"];
        if (Object.keys(as).length) imp.as = as;
      }
      imports.push(imp);
    }
  };

  for (const c of root.namedChildren) if (c) visit(c);
  return { decls, imports };
}

// ---------------------------------------------------------------- references

/** The names a file can use from its own codebase: what it declares, and what it imports from local modules. */
function knownNames(decls: Decl[], imports: Import[]): { names: Set<string>; modules: Set<string> } {
  const names = new Set(decls.map((d) => d.n));
  const modules = new Set<string>();
  for (const imp of imports) {
    for (const n of imp.n ?? []) {
      const local = imp.as?.[n] ?? n;
      if (n === "*") modules.add(local);
      else if (n === "default") {
        names.add(local);
        modules.add(local);
      } else {
        names.add(local);
        // Python `from app import billing` imports a module too: billing.charge() is a use of it.
        modules.add(local);
      }
    }
  }
  return { names, modules };
}

/** Gives each declaration the names it uses from this codebase (the innermost declaration wins). */
function attachRefs(decls: Decl[], refs: { name: string; row: number }[]): void {
  if (!decls.length || !refs.length) return;
  const order = [...decls].sort((a, b) => a.e - a.s - (b.e - b.s));
  const sets = new Map<Decl, Set<string>>();
  for (const { name, row } of refs) {
    const line = row + 1;
    const d = order.find((x) => x.s <= line && line <= x.e);
    if (!d || d.n === name) continue;
    let set = sets.get(d);
    if (!set) sets.set(d, (set = new Set()));
    if (set.size < MAX_REFS) set.add(name);
  }
  for (const [d, set] of sets) d.r = [...set];
}

const relativeOnly: IsLocal = (s) => s.startsWith(".") || s.startsWith("/");

export async function extract(lang: LangId, text: string, isLocal: IsLocal = relativeOnly): Promise<FileFacts> {
  const tree = await parse(lang, text);
  const lines = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  if (!tree) return { decls: [], imports: [], lines };
  try {
    const root = tree.rootNode;
    if (TABLE_LANGS.has(lang)) return extractWithTable(lang as TableLang, root, text, isLocal);
    const ts = lang !== "python";
    const jsx = lang === "tsx" || lang === "javascript";
    const { decls, imports, def } = ts ? tsDecls(root, jsx, isLocal) : { ...pyDecls(root, isLocal), def: undefined };

    if (ts) {
      const seen = new Set(imports.map((i) => i.s));
      for (const c of (await query(lang, TS_DYNAMIC)).captures(root)) {
        if (c.name !== "s") continue;
        const s = unquote(c.node.text);
        if (seen.has(s)) continue;
        seen.add(s);
        imports.push(isLocal(s) ? { s, n: ["*"] } : { s });
      }
    }

    const { names, modules } = knownNames(decls, imports);
    const refs: { name: string; row: number }[] = [];
    const sources = !ts ? [PY_REFS] : lang === "typescript" ? [TS_REFS, TS_TYPE_REFS] : lang === "tsx" ? [TS_REFS, JSX_REFS, TS_TYPE_REFS] : [TS_REFS, JSX_REFS];
    for (const src of sources) {
      for (const m of (await query(lang, src)).matches(root)) {
        const r = m.captures.find((c) => c.name === "r")?.node;
        if (!r) continue;
        const o = m.captures.find((c) => c.name === "o")?.node.text;
        if (o) {
          if (modules.has(o)) refs.push({ name: `${o}.${r.text}`, row: r.startPosition.row });
        } else if (names.has(r.text)) {
          refs.push({ name: r.text, row: r.startPosition.row });
        }
      }
    }
    attachRefs(decls, refs);
    return def ? { decls, imports, lines, def } : { decls, imports, lines };
  } finally {
    tree.delete();
  }
}
