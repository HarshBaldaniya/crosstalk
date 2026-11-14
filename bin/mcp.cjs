#!/usr/bin/env node
// Starts Crosstalk's tools for the Claude Code plugin and the Gemini CLI extension, the same way on
// macOS, Windows and Linux. When `npx crosstalk-ai` has already put this version (or a newer one) in
// ~/.crosstalk, that copy runs at once, offline. Otherwise npm fetches this version once.
// No dependencies: it runs straight from the plugin's folder.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const want = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const home = process.env.CROSSTALK_HOME || path.join(os.homedir(), ".crosstalk");
const local = path.join(home, "crosstalk-mcp.js");

function installed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "version.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function atLeast(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return true;
}

/** npx through the npm next to this Node.js, so no shell is needed (Windows can't start npx.cmd
 *  without one); the PATH's npx otherwise. */
function npx(args) {
  const dir = path.dirname(process.execPath);
  for (const p of [path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")]) {
    if (fs.existsSync(p)) return [process.execPath, [p, ...args], false];
  }
  return process.platform === "win32" ? [`npx ${args.join(" ")}`, [], true] : ["npx", args, false];
}

const v = installed();
const [cmd, args, shell] = v && atLeast(v, want) && fs.existsSync(local) ? [process.execPath, [local], false] : npx(["-y", "--quiet", `crosstalk-ai@${want}`, "mcp"]);
const child = spawn(cmd, args, { stdio: "inherit", shell, windowsHide: true });
child.on("error", (err) => {
  process.stderr.write(`Crosstalk couldn't start its tools: ${err.message}. Run: npx crosstalk-ai doctor\n`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
