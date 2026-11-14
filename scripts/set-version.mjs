// One version everywhere: `node scripts/set-version.mjs 0.1.0` sets it in the extension, the npm
// package (built from package.json), the Claude Code plugin, the Gemini CLI extension, and the
// crosstalk-ai version those two run. A plugin's version is what tells Claude Code there's an update.
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <x.y.z>");
  process.exit(2);
}
const edit = (file, change) => {
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file} → ${v}`);
};
const pin = (servers) => {
  for (const s of Object.values(servers ?? {})) s.args = (s.args ?? []).map((a) => (a.startsWith("crosstalk-ai@") ? `crosstalk-ai@${v}` : a));
};
edit("package.json", (j) => (j.version = v));
edit(".claude-plugin/plugin.json", (j) => ((j.version = v), pin(j.mcpServers)));
edit("gemini-extension.json", (j) => ((j.version = v), pin(j.mcpServers)));
console.log("Then: update CHANGELOG.md, npm run publish:npm, commit, tag v" + v + " and push.");
