import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addConnection,
  addPending,
  appendInbox,
  getCursor,
  logDelivery,
  matchPending,
  readConnections,
  readDeliveries,
  readInbox,
  removeConnection,
  setCursor,
  setPaused,
  takeInbox,
} from "../src/core/store";

const A = { id: "aaa", tool: "Claude" as const, title: "A" };
const B = { id: "bbb", tool: "Claude" as const, title: "B" };

beforeEach(() => {
  process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-store-"));
});

test("connections: add, re-add resumes rather than duplicates, pause, remove clears its waiting context", () => {
  const { connection, created } = addConnection(A, B, 1);
  assert.equal(created, true);
  setPaused(connection.id, true);
  const again = addConnection(A, B, 2);
  assert.equal(again.created, false);
  assert.equal(readConnections().length, 1);
  assert.equal(readConnections()[0].paused, false);

  appendInbox("bbb", { connectionId: connection.id, from: A, at: 3, kind: "update", text: "x" });
  appendInbox("bbb", { from: { ...A, id: "other" }, at: 3, kind: "update", text: "y" });
  removeConnection(connection.id);
  assert.equal(readConnections().length, 0);
  assert.deepEqual(readInbox("bbb").map((i) => i.text), ["y"]);
});

test("inbox: take empties it; odd ids are refused", () => {
  appendInbox("bbb", { from: A, at: 1, kind: "context", text: "one" });
  appendInbox("bbb", { from: A, at: 2, kind: "update", text: "two" });
  assert.deepEqual(takeInbox("bbb").map((i) => i.text), ["one", "two"]);
  assert.deepEqual(takeInbox("bbb"), []);
  appendInbox("../x", { from: A, at: 1, kind: "context", text: "no" });
  assert.ok(!fs.existsSync(path.join(process.env.CROSSTALK_HOME!, "x.jsonl")));
});

test("cursors and deliveries", () => {
  assert.equal(getCursor("aaa"), undefined);
  setCursor("aaa", 120);
  assert.equal(getCursor("aaa"), 120);
  for (let i = 0; i < 5; i++) logDelivery({ at: i, from: "aaa", to: "bbb", chars: 10 });
  assert.equal(readDeliveries().length, 5);
  assert.equal(readDeliveries(2).length, 2);
});

test("a branch is matched by the start of its task, in its folder, while fresh", () => {
  addPending({ id: "p1", from: A, title: "Caption bug", cwd: "/repo", at: 1000, taskStart: "Fix the caption   overlap on 9:16 cards", context: "ctx", keepConnected: true });
  assert.equal(matchPending("fix the caption overlap on 9:16 cards please", "/repo", 2000)?.id, "p1");
  assert.equal(matchPending("something else", "/repo", 2000), undefined);
  assert.equal(matchPending("Fix the caption overlap on 9:16 cards", "/other", 2000), undefined);
  assert.equal(matchPending("Fix the caption overlap on 9:16 cards", "/repo", 1000 + 31 * 60_000), undefined);
});

import { resolveStatus } from "../src/core/status";

test("status: the hook wins, file activity is the fallback", () => {
  const now = 100 * 60_000;
  assert.equal(resolveStatus(now - 5_000, undefined, now).status, "working");
  assert.equal(resolveStatus(now - 5 * 60_000, undefined, now).status, "done");
  assert.equal(resolveStatus(now - 60 * 60_000, undefined, now).status, "idle");
  assert.deepEqual(resolveStatus(now - 60 * 60_000, { status: "waiting", at: now - 1000, event: "Notification", message: "Needs permission" }, now), { status: "waiting", line: "Needs permission" });
  assert.equal(resolveStatus(now - 20 * 60_000, { status: "working", at: now - 20 * 60_000, event: "PostToolUse" }, now).status, "done");
});
