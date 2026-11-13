// Counting a chat's tokens: a huge file a slice at a time gives exactly what one full read gives;
// what is counted is kept for the next window; a replaced file is counted again.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude";
import { readLinesFrom } from "../src/core/transcript";
import type { ChatSession } from "../src/core/types";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-usage-home-");
});

const day = new Date().toISOString();
/** A reply written the way Claude Code writes it: once per content block, same message id, as it streams. */
function reply(i: number, pad = 0): string {
  const line = (out: number) =>
    JSON.stringify({ type: "assistant", timestamp: day, message: { id: `m${i}`, model: "claude-opus-5-5", usage: { input_tokens: 10 + i, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [{ type: "text", text: "x".repeat(pad) }] } });
  return line(1) + "\n" + line(7 + (i % 5)) + "\n";
}
function chatFile(n: number, pad: number): string {
  const file = path.join(tmp("crosstalk-usage-chat-"), "chat.jsonl");
  let text = "";
  for (let i = 0; i < n; i++) text += reply(i, pad) + JSON.stringify({ type: "user", message: { role: "user", content: `ask ${i}` } }) + "\n";
  fs.writeFileSync(file, text);
  return file;
}
const chat = (file: string): ChatSession => ({ id: "c", tool: "Claude", title: "t", status: "idle", lastModified: Date.now(), file });

test("a big file counted a slice at a time adds up to exactly one full read, and the slices end on whole lines", () => {
  const file = chatFile(600, 3000); // ~3.6 MB, 600 replies (more than are kept by id)
  const whole = new ClaudeAdapter().usage(chat(file))!;
  process.env.CROSSTALK_HOME = tmp("crosstalk-usage-home-");
  const a = new ClaudeAdapter();
  const c = chat(file);
  assert.equal(a.pendingBytes(c), fs.statSync(file).size, "nothing counted yet");
  let steps = 0;
  while (a.pendingBytes(c) > 0) {
    a.usageStep(c, 256 * 1024);
    steps++;
  }
  assert.ok(steps > 10, `read in many slices (${steps})`);
  assert.deepEqual(a.usage(c), whole);
  assert.equal(whole.total.output, [...Array(600).keys()].reduce((n, i) => n + 7 + (i % 5), 0), "a streamed reply counts once, at its final size");
});

test("what is counted is kept: the next window starts from it, and reads only what was added since", () => {
  const file = chatFile(300, 100);
  const first = new ClaudeAdapter();
  const before = first.usage(chat(file))!;
  first.saveCache();
  const next = new ClaudeAdapter();
  assert.equal(next.pendingBytes(chat(file)), 0, "nothing to read again");
  assert.deepEqual(next.usage(chat(file)), before);
  fs.appendFileSync(file, reply(1000));
  assert.ok(next.pendingBytes(chat(file)) > 0 && next.pendingBytes(chat(file)) < 2000, "only the new reply is pending");
  assert.equal(next.usage(chat(file))!.total.output, before.total.output + 7 + (1000 % 5));
});

test("a file replaced by a shorter one is counted again from the start", () => {
  const file = chatFile(50, 10);
  const a = new ClaudeAdapter();
  a.usage(chat(file));
  fs.writeFileSync(file, reply(1));
  assert.equal(a.usage(chat(file))!.total.output, 7 + 1);
});

test("lines are split on bytes: a character cut at a 4 MB read's edge is kept whole", () => {
  const file = path.join(tmp("crosstalk-usage-utf8-"), "a.jsonl");
  const first = "a".repeat(4 * 1024 * 1024 - 2) + "\n"; // the next line's "é" (2 bytes) starts 1 byte before the edge
  fs.writeFileSync(file, first + "xé😀y\nlast\n");
  const { lines, next } = readLinesFrom(file, 0);
  assert.deepEqual(lines.slice(1), ["xé😀y", "last"]);
  assert.equal(next, fs.statSync(file).size);
  // Sliced: the first slice ends after the long line; the next starts exactly there.
  const one = readLinesFrom(file, 0, 1024);
  assert.equal(one.lines.length, 1);
  assert.deepEqual(readLinesFrom(file, one.next).lines, ["xé😀y", "last"]);
});
