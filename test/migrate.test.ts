// Crosstalk was called Relay: its data and hooks move to the new names once, and nothing is lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { moveOldHome, moveOldWorkspace } from "../src/core/migrate";
import { connect, disconnect, isConnected, staleHookTargets } from "../src/core/hooks";
import { readConnections } from "../src/core/store";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("~/.relay moves into Crosstalk's home: links, inboxes and records (now flightlogs); newer files are kept", () => {
  const old = tmp("ct-old-");
  const home = path.join(tmp("ct-new-"), ".crosstalk");
  fs.mkdirSync(path.join(old, "inbox"), { recursive: true });
  fs.mkdirSync(path.join(old, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(old, "connections.json"), "[old]");
  fs.writeFileSync(path.join(old, "inbox", "a.jsonl"), "x");
  fs.writeFileSync(path.join(old, "sessions", "a.jsonl"), "{}");
  fs.writeFileSync(path.join(old, "relay-hook.js"), "old hook");
  fs.writeFileSync(path.join(old, "config.json"), '{"old":true}');
  // A window already on the new version wrote its own config.
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), '{"new":true}');
  moveOldHome(home, old);
  assert.ok(!fs.existsSync(old), "the old folder is gone");
  assert.equal(fs.readFileSync(path.join(home, "connections.json"), "utf8"), "[old]");
  assert.equal(fs.readFileSync(path.join(home, "inbox", "a.jsonl"), "utf8"), "x");
  assert.ok(fs.existsSync(path.join(home, "flightlogs", "a.jsonl")), "records are flightlogs now");
  assert.ok(!fs.existsSync(path.join(home, "relay-hook.js")), "the old hook script isn't carried over");
  assert.equal(fs.readFileSync(path.join(home, "config.json"), "utf8"), '{"new":true}', "a newer file wins");
  assert.equal(moveOldHome(home, old), 0, "a second start has nothing to move");
});

test("a project's .relay folder (Tower layout, notes) moves to .crosstalk", () => {
  const root = tmp("ct-proj-");
  fs.mkdirSync(path.join(root, ".relay", "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, ".relay", "state.json"), '{"board":{}}');
  fs.writeFileSync(path.join(root, ".relay", "notes", "n.md"), "note");
  moveOldWorkspace(root, path.join(root, ".crosstalk"));
  assert.ok(!fs.existsSync(path.join(root, ".relay")));
  assert.equal(fs.readFileSync(path.join(root, ".crosstalk", "state.json"), "utf8"), '{"board":{}}');
  assert.equal(fs.readFileSync(path.join(root, ".crosstalk", "notes", "n.md"), "utf8"), "note");
});

test("an agent's Relay hook is Crosstalk's: replaced, never doubled; other hooks stay", () => {
  const file = path.join(tmp("ct-settings-"), "settings.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"/usr/bin/node" "/h/.relay/relay-hook.js" claude || true' }] }, { hooks: [{ type: "command", command: "my-own-hook" }] }] } }),
  );
  assert.equal(isConnected(file, ["Stop"]), false, "an old hook doesn't count as on: it is rewritten first");
  connect('"/usr/bin/node" "/h/.crosstalk/crosstalk-hook.js" claude || true', file, ["Stop"]);
  const stop = JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
  assert.deepEqual(stop.sort(), ['"/usr/bin/node" "/h/.crosstalk/crosstalk-hook.js" claude || true', "my-own-hook"].sort());
  assert.equal(isConnected(file, ["Stop"]), true);
  disconnect(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop[0].hooks.map((h: { command: string }) => h.command), ["my-own-hook"]);
  void staleHookTargets;
});

test("a channel saved as Relay's 'summary' or 'headlines' reads as Brief or Ping", () => {
  process.env.CROSSTALK_HOME = tmp("ct-home-");
  fs.writeFileSync(
    path.join(process.env.CROSSTALK_HOME, "connections.json"),
    JSON.stringify([
      { id: "1", from: { id: "a" }, to: { id: "b" }, createdAt: 1, level: "summary" },
      { id: "2", from: { id: "b" }, to: { id: "a" }, createdAt: 1, level: "headlines" },
      { id: "3", from: { id: "c" }, to: { id: "a" }, createdAt: 1, level: "full" },
    ]),
  );
  assert.deepEqual(readConnections().map((c) => c.level), ["brief", undefined, "full"]);
});
