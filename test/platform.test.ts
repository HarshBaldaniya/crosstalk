// Things that must hold on macOS, Windows and Linux alike: backups, the command line, Windows line
// endings, and finding the agents' commands without a login shell.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { backUp, backupDirFor, restore } from "../src/core/backup";
import { findCommand } from "../src/core/hooks";
import { extract } from "../src/codemap/extract";
import { CodeMap } from "../src/codemap/index";
import { parseCommand } from "../src/library/index";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-plat-home-");
});

test("backup copies only what changed and never deletes; restore merges and never shortens a session log", () => {
  const home = process.env.CROSSTALK_HOME!;
  fs.mkdirSync(path.join(home, "flightlogs"), { recursive: true });
  fs.writeFileSync(path.join(home, "flightlogs", "a.jsonl"), '{"n":1}\n');
  fs.writeFileSync(path.join(home, "connections.json"), "[]");
  fs.mkdirSync(path.join(home, "codemap", "x"), { recursive: true });
  fs.writeFileSync(path.join(home, "codemap", "x", "files.jsonl.gz"), "big");
  const folder = tmp("crosstalk-backup-");

  const first = backUp(folder);
  assert.deepEqual([first.copied, first.files], [2, 2], "session logs and links; the code map is rebuilt, not backed up");
  assert.ok(!fs.existsSync(path.join(backupDirFor(folder), "codemap")));
  assert.equal(backUp(folder).copied, 0, "nothing changed, nothing copied");
  fs.appendFileSync(path.join(home, "flightlogs", "a.jsonl"), '{"n":2}\n');
  assert.equal(backUp(folder).copied, 1);

  // A new computer: empty home, restored from the folder.
  process.env.CROSSTALK_HOME = tmp("crosstalk-plat-new-");
  const r = restore(folder);
  assert.equal(r.restored, 2);
  assert.equal(fs.readFileSync(path.join(process.env.CROSSTALK_HOME, "flightlogs", "a.jsonl"), "utf8"), '{"n":1}\n{"n":2}\n');
  // Grown here since: a restore never cuts it back.
  fs.appendFileSync(path.join(process.env.CROSSTALK_HOME, "flightlogs", "a.jsonl"), '{"n":3}\n');
  assert.equal(restore(folder).restored, 0);
  assert.match(fs.readFileSync(path.join(process.env.CROSSTALK_HOME, "flightlogs", "a.jsonl"), "utf8"), /"n":3/);
});

test("Windows line endings: code, Library commands and line numbers read the same as Unix ones", async () => {
  const unix = "/** Saves it. */\nexport function save(a: string) {\n  return a;\n}\n\nexport interface Thing {\n  id: string;\n}\n";
  const crlf = unix.replace(/\n/g, "\r\n");
  const a = await extract("typescript", unix);
  const b = await extract("typescript", crlf);
  assert.deepEqual(b.decls, a.decls);
  assert.equal(b.lines, a.lines);
  assert.equal(b.decls[0].d, "Saves it.");
  const cmd = parseCommand("---\r\nname: hello\r\ndescription: Says hello\r\nargs: who* = Who\r\n---\r\nSay hello to {{who}}.\r\n")!;
  assert.deepEqual([cmd.name, cmd.description, cmd.args[0].name, cmd.body], ["hello", "Says hello", "who", "Say hello to {{who}}."]);

  const root = tmp("crosstalk-plat-repo-");
  fs.writeFileSync(path.join(root, "a.ts"), crlf);
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  assert.match(map.outline("a.ts"), / {2}2-4 {2}export function save\(a: string\)/);
  // A changed file named with the platform's own separators is still found.
  assert.equal((await map.refresh({ changed: [path.join(root, "a.ts")] })).files, 1);
});

test("finding an agent's command: the usual install places when no shell can say, on Windows too", () => {
  const found = findCommand("node");
  assert.ok(found && path.isAbsolute(found) && fs.existsSync(found), `node found at ${found}`);
  assert.equal(findCommand("no-such-command-xyz"), undefined);
  // On a Windows layout, the lookup only accepts something that can be started (.exe, .cmd).
  assert.equal(findCommand("no-such-command-xyz", "win32"), undefined);
});

const cli = path.join(__dirname, "..", "dist", "crosstalk.js");
test("the command line: map, find, check, commands and backup from any terminal", { skip: !fs.existsSync(cli) && "run npm run build first" }, () => {
  const root = tmp("crosstalk-plat-cli-");
  fs.writeFileSync(path.join(root, "upload.ts"), "/** Counts uploads in flight. */\nexport function countUploads() { return 1; }\n");
  fs.writeFileSync(path.join(root, "README.md"), "See `gone/file.ts`.\n");
  fs.mkdirSync(path.join(root, "gone"));
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env } }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };
  assert.match(run("map").out, /1 files, 1 declarations; read 1/);
  assert.match(run("find", "upload", "count").out, /^countUploads {2}function {2}upload\.ts:2-2/);
  assert.match(run("outline", "upload.ts").out, /export function countUploads\(\)/);
  const docs = run("check", "docs");
  assert.equal(docs.code, 1, "a stale doc line fails a CI step");
  assert.match(docs.out, /README\.md:1 {2}gone\/file\.ts \(file\) no longer exists/);
  assert.match(run("commands", "review my changes").out, /^\/review /);
  const folder = tmp("crosstalk-plat-bk-");
  assert.match(run("backup", folder).out, /Backed up \d+ new or changed/);
  assert.equal(run("nonsense").code, 2);
});
