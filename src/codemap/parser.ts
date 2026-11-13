// The parser: tree-sitter compiled to WASM (Microsoft's @vscode/tree-sitter-wasm build, MIT), the
// same in the extension, the MCP server and the tests. No native build, no AI.
import * as fs from "node:fs";
import * as path from "node:path";
// The package is UMD; its default export is the web-tree-sitter namespace.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitter = require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");

export type LangId = "typescript" | "tsx" | "javascript" | "python" | "go" | "rust" | "java" | "csharp" | "ruby" | "php";
export type Tree = import("@vscode/tree-sitter-wasm").Tree;
export type SyntaxNode = import("@vscode/tree-sitter-wasm").Node;
export type Language = import("@vscode/tree-sitter-wasm").Language;
export type Query = import("@vscode/tree-sitter-wasm").Query;

const BY_EXT: Record<string, LangId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
};

const GRAMMAR: Record<LangId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c-sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
};

/** The grammar files Crosstalk ships, for the build to copy. */
export const SHIPPED_GRAMMARS = ["tree-sitter.wasm", ...Object.values(GRAMMAR)];

export function langOf(file: string): LangId | undefined {
  return BY_EXT[path.extname(file).toLowerCase()];
}

/** Where the .wasm files are: next to the running bundle in a build, the package itself in tests. */
export function wasmDir(): string {
  const candidates = [process.env.CROSSTALK_WASM_DIR, path.join(__dirname, "wasm")];
  try {
    candidates.push(path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm"));
  } catch {
    // Not installed: only the bundled copy can be used.
  }
  for (const dir of candidates) if (dir && fs.existsSync(path.join(dir, "tree-sitter.wasm"))) return dir;
  throw new Error("Crosstalk's parser files (tree-sitter .wasm) are missing.");
}

let ready: Promise<void> | undefined;
const languages = new Map<LangId, Promise<Language>>();

function init(): Promise<void> {
  if (!ready) {
    const dir = wasmDir();
    ready = TreeSitter.Parser.init({ locateFile: (file: string) => path.join(dir, file) });
  }
  return ready;
}

export async function language(id: LangId): Promise<Language> {
  await init();
  let l = languages.get(id);
  if (!l) {
    l = TreeSitter.Language.load(fs.readFileSync(path.join(wasmDir(), GRAMMAR[id])));
    languages.set(id, l);
  }
  return l;
}

const parsers = new Map<LangId, import("@vscode/tree-sitter-wasm").Parser>();

/** Parses a file's text; the tree must be deleted by the caller once read. */
export async function parse(id: LangId, text: string): Promise<Tree | null> {
  const lang = await language(id);
  let p = parsers.get(id);
  if (!p) {
    p = new TreeSitter.Parser();
    p.setLanguage(lang);
    parsers.set(id, p);
  }
  return p.parse(text);
}

const queries = new Map<string, Query>();

export async function query(id: LangId, source: string): Promise<Query> {
  const key = `${id}\0${source}`;
  let q = queries.get(key);
  if (!q) {
    q = new TreeSitter.Query(await language(id), source);
    queries.set(key, q);
  }
  return q;
}
