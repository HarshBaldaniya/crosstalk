// Puts together the npm package, crosstalk-ai: the command line (crosstalk setup | doctor | update |
// remove, and the Map's find, outline, graph ...), the MCP server, the hook and the parser files.
// The same files the VS Code extension carries, so both install exactly the same thing.
//   npm run pack:npm      → npm-dist/ (and a .tgz to try with `npm install -g ./crosstalk-ai-*.tgz`)
//   npm publish ./npm-dist --access public
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const out = "npm-dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "wasm"), { recursive: true });
for (const f of ["crosstalk.js", "crosstalk-mcp.js", "crosstalk-hook.js"]) copyFileSync(join("dist", f), join(out, f));
for (const f of readdirSync("dist/wasm")) copyFileSync(join("dist/wasm", f), join(out, "wasm", f));
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(f, join(out, f));

const pkg = {
  name: "crosstalk-ai",
  version: root.version,
  description: "Set up Claude Code, Codex and Gemini CLI with a map of your code, ready-made commands and shared chat records, in one command.",
  keywords: ["claude-code", "codex", "gemini-cli", "mcp", "ai-agents", "code-map", "skills"],
  homepage: "https://github.com/HarshBaldaniya/crosstalk#readme",
  bugs: { url: "https://github.com/HarshBaldaniya/crosstalk/issues" },
  repository: { type: "git", url: "git+https://github.com/HarshBaldaniya/crosstalk.git" },
  license: "MIT",
  author: root.author,
  bin: { crosstalk: "crosstalk.js", "crosstalk-ai": "crosstalk.js" },
  files: ["crosstalk.js", "crosstalk-mcp.js", "crosstalk-hook.js", "wasm/", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  engines: { node: ">=20" },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

writeFileSync(
  join(out, "README.md"),
  `# crosstalk-ai

Crosstalk for the terminal: one command sets up **Claude Code**, **Codex** and **Gemini CLI** with a map of
your code, ready-made commands, skills, and shared records of your chats. No AI of its own; nothing
leaves your computer.

\`\`\`bash
npx crosstalk-ai setup      # every agent found on this computer
crosstalk doctor            # check everything works, with the fix for anything that doesn't
crosstalk update            # move to the newest version and refresh every agent
crosstalk remove            # take it all out again (--purge also deletes its data)
\`\`\`

After \`setup\`, your agents:

- find code through the Map (\`crosstalk_map\`) before grepping, in a few hundred tokens;
- read what your other chats did (\`crosstalk_flightlog\`) and leave notes for each other (\`crosstalk_notes\`);
- have ready-made commands (\`/crosstalk:review\` in Claude Code, \`/prompts:review\` in Codex, \`/review\` in Gemini CLI);
- have three skills they use by themselves: find code, recall past work, catch up on other chats.

The Map also works on its own: \`crosstalk find "rate limiter"\`, \`crosstalk outline src/api\`, \`crosstalk graph RateLimiter\`.

The full app, with the Tower board, Fuel and the Map as a picture, is the VS Code extension:
https://github.com/HarshBaldaniya/crosstalk

MIT © Harsh Baldaniya
`,
);
console.log(`npm-dist/ ready: ${pkg.name}@${pkg.version}`);
