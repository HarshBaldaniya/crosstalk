// The command line: package managers, finding the crosstalk command, help, completion and output.
// No test here installs anything or runs setup (setup is covered in setup.test.ts with temp homes).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli/main";
import { closest, commandInfo, COMMANDS, completion, renderCommandHelp, renderHelp, SHELLS } from "../src/cli/help";
import { globalInstall, oneOff, ourCommand, startedBy, temporary } from "../src/cli/pm";
import { bugUrl } from "../src/cli/about";
import { plain } from "../src/cli/ui";

before(() => {
  process.env.CROSSTALK_NO_UPDATE_CHECK = "1";
  process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-cli-"));
  plain();
});

/** Runs a command and returns what it printed. */
async function run(...argv: string[]): Promise<{ code: number; text: string }> {
  let text = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await main(argv), text };
  } finally {
    process.stdout.write = write;
  }
}

test("each package manager is recognised from the user agent it sets", () => {
  assert.equal(startedBy("pnpm/9.12.0 npm/? node/v22.16.0 darwin arm64"), "pnpm");
  assert.equal(startedBy("yarn/4.5.0 npm/? node/v22.16.0 linux x64"), "yarn");
  assert.equal(startedBy("bun/1.1.30 npm/? node/v22.6.0 win32 x64"), "bun");
  assert.equal(startedBy("npm/10.9.0 node/v22.16.0 darwin arm64 workspaces/false"), "npm");
  assert.equal(startedBy(""), "npm");
  assert.equal(oneOff("pnpm"), "pnpm dlx crosstalk-ai");
  assert.equal(oneOff("bun"), "bunx crosstalk-ai");
  assert.equal(oneOff("yarn", "yarn/4.5.0"), "yarn dlx crosstalk-ai");
  assert.equal(oneOff("yarn", "yarn/1.22.22"), "npx crosstalk-ai", "Yarn 1 has no dlx");
  assert.deepEqual(globalInstall("yarn", "crosstalk-ai@1.0.0", "yarn/4.5.0").bin, "npm", "Yarn 2+ has no global installs");
  assert.deepEqual(globalInstall("yarn", "crosstalk-ai@1.0.0", "yarn/1.22.22"), { bin: "yarn", args: ["global", "add", "crosstalk-ai@1.0.0"] });
  assert.deepEqual(globalInstall("pnpm", "x").args, ["add", "--global", "x"]);
});

test("the crosstalk command is ours only when it points at crosstalk-ai, and says who installed it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-bin-"));
  const pkg = path.join(dir, "lib", "node_modules", "crosstalk-ai");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "crosstalk.js"), "// cli");
  const linked = path.join(dir, "crosstalk");
  // Windows needs Developer Mode or admin rights for a symlink; its npm writes a .cmd shim instead.
  let canLink = true;
  try {
    fs.symlinkSync(path.join(pkg, "crosstalk.js"), linked);
  } catch {
    canLink = false;
  }
  if (canLink) assert.deepEqual(ourCommand(linked), { path: linked, by: "npm" });
  const cmdShim = path.join(dir, "crosstalk.cmd");
  fs.writeFileSync(cmdShim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\crosstalk-ai\\crosstalk.js" %*\r\n');
  assert.deepEqual(ourCommand(cmdShim), { path: cmdShim, by: "npm" });

  const shim = path.join(dir, "pnpm-shim");
  fs.writeFileSync(shim, '#!/bin/sh\nexec node "$basedir/global/5/.pnpm/crosstalk-ai@0.0.1/node_modules/crosstalk-ai/crosstalk.js" "$@"\n');
  assert.equal(ourCommand(shim)?.by, "pnpm");

  // npm create / npx put the package's own .bin first on the PATH while they run: that one is temporary.
  const npxBin = path.join(dir, ".npm", "_npx", "0f41de45", "node_modules", ".bin");
  fs.mkdirSync(npxBin, { recursive: true });
  fs.copyFileSync(cmdShim, path.join(npxBin, "crosstalk"));
  assert.equal(ourCommand(path.join(npxBin, "crosstalk")), undefined, "a one-run copy isn't installed");
  for (const t of ["/x/node_modules/.bin/crosstalk", "C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\.bin\\crosstalk.cmd", "/Users/a/Library/Caches/pnpm/dlx/abc/node_modules/.bin/crosstalk", "/tmp/bunx-501-create-crosstalk/node_modules/.bin/crosstalk"]) assert.ok(temporary(t), t);
  for (const t of ["/usr/local/bin/crosstalk", "/Users/a/.bun/bin/crosstalk", "/Users/a/Library/pnpm/crosstalk", "C:\\Users\\a\\AppData\\Roaming\\npm\\crosstalk.cmd"]) assert.ok(!temporary(t), t);

  const other = path.join(dir, "someone-elses");
  fs.writeFileSync(other, "#!/bin/sh\necho another program called crosstalk\n");
  assert.equal(ourCommand(other), undefined, "another program with the same name is not ours");
  assert.equal(ourCommand(path.join(dir, "missing")), undefined);
});

test("every command has a summary, help and a place in completion; aliases and typos find it", () => {
  for (const c of COMMANDS) {
    assert.ok(c.summary && !c.summary.endsWith("."), c.name);
    assert.match(renderCommandHelp(c, "crosstalk"), new RegExp(`^crosstalk ${c.name}`));
  }
  assert.equal(commandInfo("install")?.name, "setup");
  assert.equal(commandInfo("uninstall")?.name, "remove");
  assert.equal(commandInfo("upgrade")?.name, "update");
  assert.equal(closest("doctr"), "doctor");
  assert.equal(closest("statsu"), "status");
  assert.equal(closest("xyzzyplugh"), undefined);
  const page = renderHelp("crosstalk");
  for (const c of COMMANDS) assert.ok(page.includes(c.name), c.name);
  for (const s of SHELLS) {
    const script = completion(s);
    for (const c of COMMANDS) assert.ok(script.includes(c.name), `${s}: ${c.name}`);
  }
  assert.ok(completion("zsh").includes("doesn'\\''t"), "zsh quotes apostrophes");
  assert.ok(completion("powershell").includes("doesn''t"), "PowerShell quotes apostrophes");
});

test("help, version, json and typos from the command line", async () => {
  assert.match((await run("--help")).text, /USAGE/);
  assert.match((await run("help", "find")).text, /EXAMPLES/);
  assert.match((await run("find", "--help")).text, /--limit/);
  assert.equal((await run("-v")).text.trim().split("\n")[0], `crosstalk ${JSON.parse(fs.readFileSync("package.json", "utf8")).version}`);
  const v = JSON.parse((await run("version", "--json")).text);
  assert.ok(v.version && v.node && v.system);
  const typo = await run("doctr");
  assert.equal(typo.code, 2);
  assert.match(typo.text, /Did you mean doctor\?/);
  assert.equal((await run("completion", "fish")).code, 0);
  assert.equal((await run("completion", "tcsh")).code, 2);
});

test("a bug report carries the version and system, never paths", () => {
  const url = bugUrl({ version: "1.2.3", node: "22.0.0", system: "macOS 15.1 (Apple silicon)", files: "~/.crosstalk", agents: ["Codex"], command: "/Users/someone/bin/crosstalk", installedWith: "npm" });
  const body = decodeURIComponent(url.split("body=")[1]);
  assert.match(body, /Crosstalk 1\.2\.3 · Node\.js 22\.0\.0 · macOS 15\.1/);
  assert.ok(!body.includes("/Users/someone"), "no file paths");
});

test("under node --test, nothing may change the real agent folders", async () => {
  const { guardRealHome } = await import("../src/core/paths");
  assert.ok(process.env.NODE_TEST_CONTEXT, "node --test marks its test processes");
  for (const d of [".claude/settings.json", ".claude.json", ".codex/config.toml", ".gemini/settings.json", ".agents/skills/x", ".crosstalk/version.json"]) {
    assert.throws(() => guardRealHome(path.join(os.homedir(), d)), /A test tried to change/, d);
  }
  assert.doesNotThrow(() => guardRealHome(path.join(os.tmpdir(), "x", ".claude", "settings.json")));
});
