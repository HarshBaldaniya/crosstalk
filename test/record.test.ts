// The session record: a short line per ask, written from the chat's own file, read back on demand.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  catchUpRecord,
  exchangeText,
  pruneRecords,
  readAsks,
  readAsksFrom,
  readHead,
  recordContext,
  renderAsk,
  setRecordTitle,
  updateRecord,
} from "../src/core/record";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-rec-home-");
});

const j = (o: unknown) => JSON.stringify(o) + "\n";
let t = Date.parse("2026-11-12T10:00:00Z");
const ts = () => new Date((t += 60_000)).toISOString();
const you = (text: string) => j({ type: "user", timestamp: ts(), message: { role: "user", content: text } });
const ai = (text: string) => j({ type: "assistant", timestamp: ts(), message: { id: `m${t}`, role: "assistant", content: [{ type: "text", text }] } });
const edit = (file: string) => j({ type: "assistant", timestamp: ts(), message: { id: `e${t}`, role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: file } }] } });
const result = (text: string) => j({ type: "user", timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] } });

function chat(text: string): string {
  const file = path.join(tmp("crosstalk-rec-chat-"), "c.jsonl");
  fs.writeFileSync(file, text);
  return file;
}

test("a line per ask: the person's words, the final outcome, files, commits and PRs, what is open", () => {
  const file = chat(
    you("Fix the upload header count") +
      ai("Reading the upload code first.") +
      edit("/repo/src/tray.ts") +
      result("[feat/header 87aa2f750] Fix header\n 1 file changed") +
      result("https://github.com/acme/app/pull/845") +
      ai("The header now counts only what the list shows. Pushed to PR #845.\n\n**Next:** check CI on #845.") +
      you("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>") +
      ai("CI is green on PR #845.") +
      you("<command-name>/pr-review</command-name>\n<command-args>845</command-args>") +
      ai("Reviewed: two findings.\n\nShould I fix both?"),
  );
  const added = updateRecord("c1", "claude", file, { cwd: "/repo" });
  assert.equal(added.length, 2, "a finished background task is not an ask");
  const [a, b] = added;
  assert.equal(a.ask, "Fix the upload header count");
  assert.equal(a.did, "CI is green on PR #845.", "the last reply of the ask is its outcome, not the first progress note");
  assert.deepEqual(a.files, ["/repo/src/tray.ts"]);
  assert.deepEqual(a.refs.sort(), ["87aa2f750", "PR #845"]);
  assert.equal(b.ask, "/pr-review 845", "a slash command is kept as typed");
  assert.equal(b.open, "Should I fix both?");
  assert.equal(readHead("c1")!.goal, "Fix the upload header count");
  assert.equal(readHead("c1")!.n, 2);
});

test("words written into files are not taken for commits; a title's 'PR 495' is not a PR", () => {
  const file = chat(
    you("Rename the api PR 495 chat") +
      j({ type: "assistant", message: { id: "w", content: [{ type: "tool_use", name: "Write", input: { file_path: "/r/a.md", content: "[branch abc1234] example" } }] } }) +
      ai("Renamed it."),
  );
  const [a] = updateRecord("c2", "claude", file);
  assert.deepEqual(a.refs, []);
});

test("a long paste is shortened, saying how much was left out", () => {
  const file = chat(you(`Why does this fail?\n${"x".repeat(5000)}`) + ai("A missing import."));
  const [a] = updateRecord("c3", "claude", file);
  assert.ok(a.ask.length < 650);
  assert.match(a.ask, /\[\+[\d,]+ characters\]$/);
});

test("read a slice at a time, a big chat gives exactly the record one full read gives, huge asks included", async () => {
  let text = "";
  for (let i = 0; i < 40; i++) text += you(`ask ${i}`) + ai(`working on ${i}`) + result("y".repeat(i % 7 === 0 ? 300_000 : 2_000)) + ai(`done ${i}`);
  const file = chat(text);
  const whole = updateRecord("full", "claude", file, { startMax: Infinity });
  // The chat file is old (not being written): every ask is read, in 64 KB slices.
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  await catchUpRecord("sliced", "claude", file, { slice: 64 * 1024 });
  const sliced = readAsks("sliced");
  assert.equal(sliced.length, 40);
  assert.deepEqual(
    sliced.map((a) => [a.ask, a.did]),
    whole.map((a) => [a.ask, a.did]),
  );
  assert.ok(sliced.every((a, i) => a.did === `done ${i}`), "no ask cut short at a slice's edge");
});

test("a chat still working keeps its newest ask back; the hook records it when the reply ends", async () => {
  const file = chat(you("first") + ai("one") + you("second, still going") + ai("thinking…"));
  await catchUpRecord("w", "claude", file);
  assert.deepEqual(readAsks("w").map((a) => a.ask), ["first"]);
  fs.appendFileSync(file, ai("All done."));
  updateRecord("w", "claude", file, { lastReply: "All done." });
  assert.deepEqual(readAsks("w").map((a) => [a.ask, a.did]), [["first", "one"], ["second, still going", "All done."]]);
});

test("the hook doesn't start a record for a big chat (the extension catches it up); a small one starts at once", () => {
  const big = chat(you("x") + ai("y".repeat(200)));
  assert.deepEqual(updateRecord("big", "claude", big, { startMax: 10 }), []);
  assert.equal(readHead("big"), undefined);
  assert.equal(updateRecord("small", "claude", big).length, 1);
});

test("the exact words of an ask, read again from the chat's own file", () => {
  const file = chat(you("first") + ai("one") + you("second ask") + ai("Second answer, word for word.") + you("third") + ai("three"));
  updateRecord("x", "claude", file);
  const text = exchangeText("x", 2)!;
  assert.match(text, /\*\*You:\*\* second ask/);
  assert.match(text, /\*\*Claude:\*\* Second answer, word for word\./);
  assert.doesNotMatch(text, /third|first/);
});

test("on linking: what it set out to do and the latest asks; linked again, only what is new", () => {
  const file = chat(you("Build checkout") + ai("Built.") + you("Add tax") + ai("Tax added.") + you("Fix rounding") + ai("Rounded."));
  updateRecord("k", "claude", file);
  setRecordTitle("k", "Checkout");
  const ctx = recordContext("k", "Checkout", { latest: 2 })!;
  assert.match(ctx, /^It set out to: Build checkout\n3 asks so far; the latest 2:/);
  assert.match(ctx, /\*\*Asked:\*\* Add tax\n\*\*Done:\*\* Tax added\./);
  assert.doesNotMatch(ctx, /Asked:\*\* Build checkout/);
  assert.match(ctx, /crosstalk_flightlog tool \(chat "Checkout"\)/);
  const asks = readAsks("k");
  const again = recordContext("k", "Checkout", { since: asks[1].at })!;
  assert.match(again, /^New since it last reached this chat \(3 asks in all\):/);
  assert.match(again, /Fix rounding/);
  assert.doesNotMatch(again, /Add tax/);
  assert.match(recordContext("k", "Checkout", { since: asks[2].at })!, /^Nothing new since it last reached this chat/);
});

test("headlines are one short line; a summary says asked, done, open, files; elsewhere, full paths", () => {
  const a = { n: 1, at: 0, ask: "Fix the header", did: "The header counts the list. Also pushed it.", open: "Next: CI", files: ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/d.ts"], refs: ["PR #845"], src: [0, 1] as [number, number] };
  assert.equal(renderAsk(a, "ping", { root: "/repo" }), "• Fix the header → The header counts the list. (files: src/a.ts, src/b.ts, src/c.ts (+1) · PR #845)");
  const s = renderAsk(a, "brief", { root: "/repo", absolute: true });
  assert.match(s, /^\*\*Asked:\*\* Fix the header\n\*\*Done:\*\* The header counts the list\. Also pushed it\.\n\*\*Open:\*\* Next: CI\nFiles: \/repo\/src\/a\.ts/);
});

test("records unused for 30 days are deleted, unless their chat is still linked", () => {
  const file = chat(you("a") + ai("b"));
  updateRecord("old", "claude", file, { now: Date.now() - 40 * 86_400_000 });
  updateRecord("linked", "claude", file, { now: Date.now() - 40 * 86_400_000 });
  updateRecord("new", "claude", file);
  assert.equal(pruneRecords(new Set(["linked"])), 1);
  assert.equal(readHead("old"), undefined);
  assert.ok(readHead("linked") && readHead("new"));
});

test("codex and gemini chats get records too", () => {
  const msg = (role: string, text: string) => j({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  const codex = chat(j({ type: "session_meta", payload: { id: "c" } }) + msg("user", "Add dark mode") + msg("assistant", "Dark mode added."));
  assert.deepEqual(updateRecord("cx", "codex", codex).map((a) => [a.ask, a.did]), [["Add dark mode", "Dark mode added."]]);
  const gem = path.join(tmp("crosstalk-rec-g-"), "s.jsonl");
  fs.writeFileSync(gem, [JSON.stringify({ sessionId: "g" }), JSON.stringify({ id: "u", type: "user", content: [{ text: "Plan the API" }] }), JSON.stringify({ id: "a", type: "gemini", content: "Here is the plan." })].join("\n"));
  assert.deepEqual(updateRecord("gm", "gemini", gem).map((a) => [a.ask, a.did, a.src]), [["Plan the API", "Here is the plan.", [0, 2]]]);
  assert.equal(readAsksFrom("gemini", gem, 2, 2).asks.length, 0, "read again from its end: nothing new");
});

const builtTools = path.join(__dirname, "..", "dist", "crosstalk-mcp.js");
test("an agent reads records through Crosstalk's tools: list, one chat (narrowed by words), one ask word for word", { skip: !fs.existsSync(builtTools) && "run npm run build first" }, async () => {
  const file = chat(you("Build checkout") + ai("Built the checkout.") + you("Fix the tax rounding") + ai("Rounding fixed in tax.ts."));
  updateRecord("mcp1", "claude", file, { cwd: "/repo" });
  setRecordTitle("mcp1", "Checkout work");
  const child = spawn(process.execPath, [builtTools], { env: { ...process.env, CROSSTALK_ROOT: "/repo" }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await call("tools/list", {})).result.tools.map((x: any) => x.name);
    assert.ok(tools.includes("crosstalk_flightlog"));
    const text = async (name: string, args: unknown) => (await call("tools/call", { name, arguments: args })).result.content[0].text as string;
    assert.match(await text("crosstalk_flightlog", {}), /Checkout work · repo · 2 asks/);
    const one = await text("crosstalk_flightlog", { chat: "checkout" });
    assert.match(one, /It set out to: Build checkout/);
    assert.match(one, /#2 · .* · Fix the tax rounding → Rounding fixed in tax\.ts\./);
    const narrowed = await text("crosstalk_flightlog", { chat: "mcp1", query: "tax" });
    assert.match(narrowed, /1 ask mention "tax"/);
    assert.doesNotMatch(narrowed, /#1 ·/);
    assert.match(await text("crosstalk_flightlog", { chat: "mcp1", n: 2 }), /\*\*You:\*\* Fix the tax rounding\n\n\*\*Claude:\*\* Rounding fixed in tax\.ts\./);
  } finally {
    child.kill();
  }
});

test("from what commands printed, only git's own commit output and PR links count; mentions of other work don't", () => {
  const file = chat(
    you("Commit the fix") +
      result("[fix/header 87aa2f750] Fix header\n 2 files changed, 10 insertions(+)") +
      result("Reading notes: Refs: PR #845, and an example line [branch abc1234] in a file") +
      result("https://github.com/acme/app/pull/901") +
      ai("Committed."),
  );
  const [a] = updateRecord("refs", "claude", file);
  assert.deepEqual(a.refs.sort(), ["87aa2f750", "PR #901"]);
});
