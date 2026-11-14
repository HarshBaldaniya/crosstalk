// Puts together the npm package, crosstalk-ai: the command line (`npx crosstalk-ai`, doctor, update,
// remove, and the Map's find, outline, graph ...), the MCP server, the hook and the parser files.
// The same files the VS Code extension carries, so both install exactly the same thing.
//   npm run pack:npm      → npm-dist/ (and a .tgz to try with `npm install -g ./crosstalk-ai-*.tgz`)
//   npm publish ./npm-dist --access public
// and create-crosstalk (npm-dist-create/), a two-line wrapper so `npm create crosstalk` (and pnpm,
// yarn and bun create) runs it: the plain name `crosstalk` on npm belongs to an older package.
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
npm create crosstalk         # set up every agent found, and add the crosstalk command
crosstalk                    # what each agent has
crosstalk doctor             # check everything works, with the fix for anything that doesn't
crosstalk update             # move to the newest version and refresh every agent
crosstalk remove             # take it all out again (--purge also deletes its data)
\`\`\`

The same on macOS (Apple silicon and Intel), Windows and Linux, with Node.js 20 or newer. Without
installing anything: \`npx crosstalk-ai\`, \`npx crosstalk-ai doctor\` and so on.

Once set up, your agents:

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

const create = "npm-dist-create";
rmSync(create, { recursive: true, force: true });
mkdirSync(create);
copyFileSync("LICENSE", join(create, "LICENSE"));
writeFileSync(
  join(create, "create.js"),
  `#!/usr/bin/env node
// \`npm create crosstalk\`: runs Crosstalk (the crosstalk-ai package) with whatever follows it.
"use strict";
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, [require.resolve("crosstalk-ai/crosstalk.js"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
);
writeFileSync(
  join(create, "package.json"),
  `${JSON.stringify(
    {
      name: "create-crosstalk",
      version: root.version,
      description: "npm create crosstalk: set up Claude Code, Codex and Gemini CLI with Crosstalk in one command.",
      keywords: pkg.keywords,
      homepage: pkg.homepage,
      bugs: pkg.bugs,
      repository: pkg.repository,
      license: "MIT",
      author: root.author,
      bin: { "create-crosstalk": "create.js" },
      files: ["create.js", "README.md", "LICENSE"],
      engines: pkg.engines,
      dependencies: { [pkg.name]: root.version },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(create, "README.md"),
  `# create-crosstalk

\`\`\`bash
npm create crosstalk
\`\`\`

Sets up Claude Code, Codex and Gemini CLI with [Crosstalk](https://github.com/HarshBaldaniya/crosstalk) and adds the
\`crosstalk\` command. Then: \`crosstalk doctor\`, \`crosstalk update\`, \`crosstalk remove\`. This package only starts
[crosstalk-ai](https://www.npmjs.com/package/crosstalk-ai), where everything lives.

MIT © Harsh Baldaniya
`,
);
console.log(`${create}/ ready: create-crosstalk@${root.version}`);
