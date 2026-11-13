// Go, Rust, Java, C#, Ruby and PHP: one reader, driven by a small table per language. Each table says
// which syntax nodes are declarations (and of what kind), which hold other declarations (a class
// body, an impl block, a namespace), what counts as public, and how imports and calls are written.
import type { SyntaxNode } from "./parser";
import type { Decl, DeclKind, FileFacts, Import, IsLocal } from "./extract";

export type TableLang = "go" | "rust" | "java" | "csharp" | "ruby" | "php";

interface Table {
  /** Node type → kind; "method" is used when inside a type */
  defs: Record<string, DeclKind>;
  /** Node types whose children are walked for more declarations */
  descend: Set<string>;
  /** The name of a declaration node */
  name(n: SyntaxNode): string | undefined;
  /** Public, as the language says it */
  exported(n: SyntaxNode, name: string): boolean;
  /** The type a method belongs to, when the method sits outside it (Go receivers) */
  owner?(n: SyntaxNode): string | undefined;
  /** Imports in one statement */
  imports(n: SyntaxNode, isLocal: IsLocal): Import[] | undefined;
  /** Calls and uses: [object, name] or [undefined, name] */
  refs(n: SyntaxNode): [string | undefined, string] | undefined;
  /** Uses of other files' code that need no import (same package, autoloading): kept by shape */
  openRefs: RegExp;
}

const field = (n: SyntaxNode, f: string) => n.childForFieldName(f);
const nameField = (n: SyntaxNode) => field(n, "name")?.text;
const unquote = (t: string) => t.replace(/^[`'"]|[`'"]$/g, "");
const hasChild = (n: SyntaxNode, test: (c: SyntaxNode) => boolean) => n.children.some((c) => !!c && test(c));
const modifiersText = (n: SyntaxNode) =>
  n.children
    .filter((c): c is SyntaxNode => !!c && /modifier/.test(c.type))
    .map((c) => c.text)
    .join(" ");
const typeKind = (body?: SyntaxNode | null): DeclKind => (body?.type === "interface_type" ? "interface" : body?.type === "struct_type" ? "class" : "type");

const TABLES: Record<TableLang, Table> = {
  go: {
    defs: { function_declaration: "function", method_declaration: "method", type_spec: "type", const_spec: "const" },
    descend: new Set(["type_declaration", "const_declaration"]),
    name: nameField,
    exported: (_n, name) => /^[A-Z]/.test(name),
    owner: (n) => {
      if (n.type !== "method_declaration") return undefined;
      const recv = field(n, "receiver")?.text ?? "";
      return /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\)\s*$/.exec(recv)?.[1];
    },
    imports: (n, isLocal) => {
      if (n.type !== "import_declaration") return undefined;
      const out: Import[] = [];
      for (const spec of n.descendantsOfType("import_spec")) {
        const p = spec && unquote(field(spec, "path")?.text ?? "");
        if (!spec || !p) continue;
        const alias = field(spec, "name")?.text;
        out.push(isLocal(p) ? { s: p, n: ["*"], as: { "*": alias && alias !== "_" && alias !== "." ? alias : p.split("/").pop()! } } : { s: p });
      }
      return out;
    },
    refs: (n) => {
      if (n.type === "call_expression") {
        const f = field(n, "function");
        if (f?.type === "identifier") return [undefined, f.text];
        if (f?.type === "selector_expression") {
          const o = field(f, "operand");
          const fld = field(f, "field");
          if (o?.type === "identifier" && fld) return [o.text, fld.text];
        }
      }
      if (n.type === "composite_literal") {
        const t = field(n, "type");
        if (t?.type === "type_identifier") return [undefined, t.text];
      }
      return undefined;
    },
    // Same package, other files: any call by name.
    openRefs: /^[A-Za-z_]\w*$/,
  },
  rust: {
    defs: {
      function_item: "function",
      function_signature_item: "method",
      struct_item: "class",
      enum_item: "enum",
      union_item: "class",
      trait_item: "interface",
      type_item: "type",
      const_item: "const",
      static_item: "const",
      mod_item: "namespace",
      macro_definition: "function",
    },
    descend: new Set(["impl_item", "declaration_list", "mod_item", "trait_item"]),
    name: nameField,
    exported: (n) => hasChild(n, (c) => c.type === "visibility_modifier"),
    imports: (n, isLocal) => {
      if (n.type !== "use_declaration") return undefined;
      const arg = field(n, "argument")?.text?.replace(/\s+/g, "") ?? "";
      const out: Import[] = [];
      const add = (base: string, names: string[]) => {
        const imp: Import = { s: base };
        if (isLocal(base)) imp.n = names.map((x) => x.split("as")[0]);
        out.push(imp);
      };
      const brace = /^(.*)::\{(.*)\}$/.exec(arg);
      if (brace) add(brace[1], brace[2].split(",").filter(Boolean));
      else {
        const parts = arg.split("::");
        add(parts.length > 1 ? parts.slice(0, -1).join("::") : arg, [parts[parts.length - 1]]);
      }
      return out;
    },
    refs: (n) => {
      if (n.type === "call_expression") {
        const f = field(n, "function");
        if (f?.type === "identifier") return [undefined, f.text];
        if (f?.type === "scoped_identifier") {
          // Invoice::new() is a use of Invoice; db::save() of save.
          const name = field(f, "name")?.text;
          const path = field(f, "path")?.text.split("::").pop();
          if (path && /^[A-Z]\w*$/.test(path)) return [undefined, path];
          if (name) return [undefined, name];
        }
      }
      if (n.type === "struct_expression") {
        const t = field(n, "name");
        if (t) return [undefined, t.text.split("::").pop()!];
      }
      return undefined;
    },
    openRefs: /^[A-Z]\w*$/,
  },
  java: {
    defs: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "class",
      annotation_type_declaration: "interface",
      method_declaration: "method",
      constructor_declaration: "method",
    },
    descend: new Set(["class_body", "interface_body", "enum_body", "enum_body_declarations"]),
    name: nameField,
    exported: (n) => /\bpublic\b/.test(modifiersText(n)),
    imports: (n, isLocal) => {
      if (n.type !== "import_declaration") return undefined;
      const text = n.text.replace(/^import\s+(static\s+)?/, "").replace(/;\s*$/, "").trim();
      const star = text.endsWith(".*");
      const s = star ? text.slice(0, -2) : text;
      const last = s.split(".").pop()!;
      return [isLocal(s) ? { s, n: [star ? "*" : last] } : { s }];
    },
    refs: (n) => {
      if (n.type === "method_invocation") {
        const name = field(n, "name")?.text;
        const obj = field(n, "object");
        if (obj?.type === "identifier" && /^[A-Z]/.test(obj.text)) return [undefined, obj.text];
        if (name && !obj) return [undefined, name];
      }
      if (n.type === "object_creation_expression") {
        const t = field(n, "type");
        if (t) return [undefined, t.text.replace(/<.*$/, "").split(".").pop()!];
      }
      if (n.type === "superclass" || n.type === "super_interfaces") {
        const t = n.descendantsOfType("type_identifier")[0];
        if (t) return [undefined, t.text];
      }
      return undefined;
    },
    openRefs: /^[A-Z]\w*$/,
  },
  csharp: {
    defs: {
      class_declaration: "class",
      struct_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "class",
      record_struct_declaration: "class",
      delegate_declaration: "type",
      method_declaration: "method",
      constructor_declaration: "method",
      namespace_declaration: "namespace",
      file_scoped_namespace_declaration: "namespace",
    },
    descend: new Set(["namespace_declaration", "file_scoped_namespace_declaration", "declaration_list"]),
    name: (n) => (n.type.includes("namespace") ? field(n, "name")?.text : nameField(n)),
    exported: (n) => /\b(public|internal)\b/.test(modifiersText(n)) || n.type.includes("namespace"),
    imports: (n, isLocal) => {
      if (n.type !== "using_directive") return undefined;
      const q = n.namedChildren.find((c) => c && (c.type === "qualified_name" || c.type === "identifier"))?.text;
      if (!q) return undefined;
      return [isLocal(q) ? { s: q, n: ["*"] } : { s: q }];
    },
    refs: (n) => {
      if (n.type === "invocation_expression") {
        const f = field(n, "function");
        if (f?.type === "identifier") return [undefined, f.text];
        if (f?.type === "member_access_expression") {
          const e = field(f, "expression");
          if (e?.type === "identifier" && /^[A-Z]/.test(e.text)) return [undefined, e.text];
        }
      }
      if (n.type === "object_creation_expression") {
        const t = field(n, "type");
        if (t) return [undefined, t.text.replace(/<.*$/, "").split(".").pop()!];
      }
      if (n.type === "base_list") {
        const t = n.namedChildren[0];
        if (t) return [undefined, t.text.replace(/<.*$/, "")];
      }
      return undefined;
    },
    openRefs: /^[A-Z]\w*$/,
  },
  ruby: {
    defs: { class: "class", module: "namespace", method: "method", singleton_method: "method" },
    descend: new Set(["class", "module", "body_statement"]),
    name: (n) => field(n, "name")?.text.split("::").pop(),
    exported: (_n, name) => !name.startsWith("_"),
    imports: (n, isLocal) => {
      if (n.type !== "call") return undefined;
      const m = field(n, "method")?.text;
      if (m !== "require" && m !== "require_relative" && m !== "load") return undefined;
      const s = n.descendantsOfType("string_content")[0]?.text;
      if (!s) return undefined;
      const src = m === "require_relative" && !s.startsWith(".") ? `./${s}` : s;
      return [isLocal(src) ? { s: src, n: ["*"] } : { s: src }];
    },
    refs: (n) => {
      if (n.type === "call") {
        const recv = field(n, "receiver");
        const m = field(n, "method")?.text;
        if (recv?.type === "constant") return [undefined, recv.text];
        if (!recv && m) return [undefined, m];
      }
      if (n.type === "superclass") {
        const c = n.namedChildren[0];
        if (c) return [undefined, c.text.split("::").pop()!];
      }
      return undefined;
    },
    openRefs: /^[A-Z]\w*$|^[a-z_]\w*[?!]?$/,
  },
  php: {
    defs: {
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "interface",
      enum_declaration: "enum",
      function_definition: "function",
      method_declaration: "method",
    },
    descend: new Set(["declaration_list", "namespace_definition", "compound_statement"]),
    name: nameField,
    exported: (n) => !/\b(private|protected)\b/.test(modifiersText(n)),
    imports: (n, isLocal) => {
      if (n.type !== "namespace_use_declaration") return undefined;
      const out: Import[] = [];
      for (const clause of n.descendantsOfType("namespace_use_clause")) {
        const q = clause?.namedChildren[0]?.text?.replace(/^\\/, "");
        if (!q) continue;
        const last = q.split("\\").pop()!;
        const alias = clause?.namedChildren[1]?.text;
        const imp: Import = { s: q };
        if (isLocal(q)) {
          imp.n = [last];
          if (alias && alias !== last) imp.as = { [last]: alias };
        }
        out.push(imp);
      }
      return out;
    },
    refs: (n) => {
      if (n.type === "function_call_expression") {
        const f = field(n, "function");
        if (f?.type === "name") return [undefined, f.text];
      }
      if (n.type === "scoped_call_expression") {
        const s = field(n, "scope");
        if (s?.type === "name" || s?.type === "qualified_name") return [undefined, s.text.split("\\").pop()!];
      }
      if (n.type === "object_creation_expression") {
        const c = n.namedChildren.find((x) => x && (x.type === "name" || x.type === "qualified_name"));
        if (c) return [undefined, c.text.split("\\").pop()!];
      }
      if (n.type === "base_clause" || n.type === "class_interface_clause") {
        const c = n.namedChildren[0];
        if (c) return [undefined, c.text.split("\\").pop()!];
      }
      return undefined;
    },
    openRefs: /^[A-Z]\w*$/,
  },
};

const MAX_REFS = 60;
const MAX_DOC = 120;
const squash = (t: string, max: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The doc comment above a node: the run of comment lines right above it, first meaningful line. */
function docAbove(node: SyntaxNode): string | undefined {
  const run: SyntaxNode[] = [];
  let prev = node.previousNamedSibling;
  let row = node.startPosition.row;
  while (prev && /comment/.test(prev.type) && row - prev.endPosition.row <= 1) {
    run.unshift(prev);
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  for (const c of run) {
    for (const raw of c.text.split("\n")) {
      const l = raw
        .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/[/!]?|#)\s?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/<\/?[a-z]+[^>]*>/gi, "")
        .trim();
      if (l && !l.startsWith("@") && !/^(TODO|FIXME|-{3,}|={3,})/.test(l)) return squash(l, MAX_DOC);
    }
  }
  return undefined;
}

export function extractWithTable(lang: TableLang, root: SyntaxNode, text: string, isLocal: IsLocal): FileFacts {
  const t = TABLES[lang];
  const decls: Decl[] = [];
  const imports: Import[] = [];
  const typeOwners = new Set(["class", "interface", "enum"]);

  const visit = (node: SyntaxNode, parent: string | undefined, inType: boolean) => {
    const imps = t.imports(node, isLocal);
    if (imps) {
      imports.push(...imps);
      return;
    }
    let kind = t.defs[node.type];
    let nextParent = parent;
    let nextInType = inType;
    if (kind) {
      const name = t.name(node);
      if (name) {
        if (node.type === "type_spec") kind = typeKind(field(node, "type"));
        const owner = t.owner?.(node);
        if ((kind === "function" && inType) || owner) kind = "method";
        const d: Decl = { n: name, k: kind, s: node.startPosition.row + 1, e: node.endPosition.row + 1 };
        // A Go type and a const sit inside a declaration node: its comment is above that.
        const docNode = node.type === "type_spec" || node.type === "const_spec" ? (node.parent && node.parent.namedChildren.length === 1 ? node.parent : node) : node;
        if (docNode !== node) {
          d.s = docNode.startPosition.row + 1;
          d.e = docNode.endPosition.row + 1;
        }
        if (t.exported(node, name)) d.x = true;
        const doc = docAbove(docNode);
        if (doc) d.d = doc;
        const p = owner ?? parent;
        if (p && (kind === "method" || kind === "const" || typeOwners.has(kind))) d.p = p;
        if (kind === "const" && !d.x) {
          // A private constant is noise, as in TypeScript.
        } else decls.push(d);
        if (typeOwners.has(kind) || kind === "namespace") {
          nextParent = kind === "namespace" && lang !== "ruby" ? parent : name;
          nextInType = kind !== "namespace";
        }
      }
    } else if (node.type === "impl_item") {
      nextParent = field(node, "type")?.text.replace(/<.*$/, "");
      nextInType = true;
    }
    if (kind || t.descend.has(node.type) || node.type === "impl_item" || node === root) {
      for (const c of node.namedChildren) if (c) visit(c, nextParent, nextInType);
    }
  };
  visit(root, undefined, false);

  // Uses: walk every node once (iteratively), attaching each to the innermost declaration around it.
  const known = new Set(decls.map((d) => d.n));
  const modules = new Set<string>();
  for (const imp of imports) for (const n of imp.n ?? []) (n === "*" ? modules : known).add(imp.as?.[n] ?? n);
  for (const imp of imports) if (imp.as?.["*"]) modules.add(imp.as["*"]);
  const refs: { name: string; row: number }[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    const r = t.refs(n);
    if (r) {
      const [o, name] = r;
      if (o) {
        if (modules.has(o)) refs.push({ name: `${o}.${name}`, row: n.startPosition.row });
      } else if (known.has(name) || t.openRefs.test(name)) refs.push({ name, row: n.startPosition.row });
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  const order = [...decls].sort((a, b) => a.e - a.s - (b.e - b.s));
  const sets = new Map<Decl, Set<string>>();
  for (const { name, row } of refs) {
    const line = row + 1;
    const d = order.find((x) => x.s <= line && line <= x.e && x.k !== "namespace");
    if (!d || d.n === name) continue;
    let set = sets.get(d);
    if (!set) sets.set(d, (set = new Set()));
    if (set.size < MAX_REFS) set.add(name);
  }
  for (const [d, set] of sets) d.r = [...set];

  const lines = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  return { decls, imports, lines };
}

/** Packages and folders of these languages that are never the codebase's own code. */
export const TABLE_SKIP_DIR = /(^|\/)(target|bin|obj|\.gradle|\.idea|Pods|DerivedData|vendor\/bundle)(\/|$)/;
