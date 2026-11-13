// Builds the four pieces Crosstalk ships, all from TypeScript:
//   dist/extension.js   the VS Code extension (Node, CommonJS, `vscode` left external)
//   dist/crosstalk-hook.js  the Claude Code hook that reports live status
//   dist/crosstalk-mcp.js   the MCP server that lets any AI tool save and read notes
//   dist/webview.js     the React UI for the sidebar and the board (+ webview.css)
//   dist/crosstalk.js   the command line: map, find, check, backup ... on any computer
//   dist/wasm/          the code map's parser (tree-sitter runtime and grammars)
// `--tests` instead builds test/*.test.ts into out-test/ for `node --test`.
import { build, context } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

// The Agent SDK is an ES module that reads `import.meta.url`; in a CommonJS
// bundle that is undefined, so it is defined from the bundle's own file name.
const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: watch || tests,
  logLevel: "info",
  banner: { js: 'const __crosstalk_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__crosstalk_import_meta_url" },
  // The Library's commands are Markdown files, bundled as text.
  loader: { ".md": "text" },
};

const configs = tests
  ? [
      {
        ...node,
        entryPoints: readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`),
        outdir: "out-test",
        external: ["vscode"],
      },
    ]
  : [
      { ...node, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
      { ...node, entryPoints: ["src/hook/crosstalk-hook.ts"], outfile: "dist/crosstalk-hook.js" },
      { ...node, entryPoints: ["src/mcp/server.ts"], outfile: "dist/crosstalk-mcp.js" },
      { ...node, entryPoints: ["src/cli/main.ts"], outfile: "dist/crosstalk.js" },
      {
        bundle: true,
        platform: "browser",
        format: "iife",
        target: "es2022",
        jsx: "automatic",
        minify: !watch,
        sourcemap: watch,
        logLevel: "info",
        define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
        // Tool logos are inlined as SVG text.
        loader: { ".svg": "text" },
        entryPoints: ["webview-ui/main.tsx"],
        outfile: "dist/webview.js",
      },
    ];

// The code map's parser: tree-sitter's runtime and the grammars Crosstalk reads, next to the bundles.
const GRAMMARS = [
  "tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c-sharp.wasm",
  "tree-sitter-ruby.wasm",
  "tree-sitter-php.wasm",
];
if (!tests) {
  const from = join(dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
  mkdirSync("dist/wasm", { recursive: true });
  for (const g of GRAMMARS) copyFileSync(join(from, g), join("dist/wasm", g));
}

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
