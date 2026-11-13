// Chats from other folders: which are shown, read cheaply, listed for every folder, and how
// work passes between chats in different folders.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addOpenRequest, dropOpenRequest, isTempFolder, pickElsewhere, takeOpenRequests } from "../src/core/folders";
import { readTail } from "../src/core/transcript";
import { formatDelivery, buildContext } from "../src/core/updates";
import { handle } from "../src/hook/crosstalk-hook";
import { addConnection, appendInbox, readInbox, setCursor } from "../src/core/store";
import { GeminiAdapter } from "../src/adapters/gemini";
import { CodexAdapter } from "../src/adapters/codex";
import { ClaudeAdapter } from "../src/adapters/claude";
import { claudeProjectsDir } from "../src/core/paths";
import type { ChatSession } from "../src/core/types";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const j = (o: unknown) => JSON.stringify(o);

beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-home-");
  process.env.CROSSTALK_CLAUDE_SETTINGS = path.join(tmp("crosstalk-claude-"), "settings.json");
});

const chat = (id: string, cwd: string, mins: number): ChatSession => ({ id, tool: "Claude", title: id, cwd, lastModified: Date.now() - mins * 60_000, status: "idle" });

test("other folders: the newest few of each, so one busy folder can't crowd out the rest; linked chats always stay", () => {
  const busy = Array.from({ length: 30 }, (_, i) => chat(`fe${i}`, "/work/frontend", i));
  const quiet = [chat("be1", "/work/backend", 100), chat("be2", "/work/backend", 200)];
  const old = chat("old-linked", "/work/legacy", 99_999);
  const shown = pickElsewhere([...busy, ...quiet, old], new Set(["old-linked"]), 15, 25);
  assert.equal(shown.filter((s) => s.cwd === "/work/frontend").length, 15);
  assert.deepEqual(shown.filter((s) => s.cwd === "/work/backend").map((s) => s.id), ["be1", "be2"]);
  assert.ok(shown.some((s) => s.id === "old-linked"), "a linked chat shows however old");
  // At most so many folders.
  const many = Array.from({ length: 40 }, (_, i) => chat(`c${i}`, `/work/p${i}`, i));
  assert.equal(new Set(pickElsewhere(many, new Set(), 15, 25).map((s) => s.cwd)).size, 25);
});

test("readTail: only the end of a file, whole lines only", () => {
  const file = path.join(tmp("crosstalk-tail-"), "a.jsonl");
  const lines = Array.from({ length: 5000 }, (_, i) => j({ n: i, pad: "x".repeat(100) }));
  fs.writeFileSync(file, lines.join("\n") + "\n" + '{"n":"half');
  const tail = readTail(file, 4096);
  assert.ok(tail.length > 10 && tail.length < 60);
  for (const l of tail) JSON.parse(l); // every line whole
  assert.equal(JSON.parse(tail[tail.length - 1]).n, 4999);
});

test("a chat in another folder gets full file paths and is told which folder the work is in", () => {
  const fe = { id: "fe000000-0000-4000-8000-000000000000", tool: "Claude" as const, title: "Frontend chat", cwd: "/work/frontend" };
  const be = { id: "be000000-0000-4000-8000-000000000000", tool: "Claude" as const, title: "Backend chat", cwd: "/work/backend" };
  const fe2 = { id: "fe200000-0000-4000-8000-000000000000", tool: "Claude" as const, title: "Other frontend chat", cwd: "/work/frontend" };
  addConnection(fe, be);
  addConnection(fe, fe2);
  const file = path.join(tmp("crosstalk-fe-"), "fe.jsonl");
  const user = (uuid: string, text: string) => j({ type: "user", uuid, message: { role: "user", content: text } }) + "\n";
  const edit = j({
    type: "assistant",
    uuid: "a1",
    message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/work/frontend/src/api.ts" } }] },
  });
  fs.writeFileSync(file, "");
  setCursor(fe.id, 0);
  fs.appendFileSync(file, user("u1", "Call the new /accounts endpoint") + edit + "\n");
  handle({ session_id: fe.id, transcript_path: file, hook_event_name: "Stop", cwd: fe.cwd, last_assistant_message: "Switched the client to /accounts." }, 1);

  const toBackend = readInbox(be.id)[0];
  assert.match(toBackend.text, /\/work\/frontend\/src\/api\.ts/, "full path for the other folder");
  assert.equal(toBackend.from.cwd, "/work/frontend");
  const toSame = readInbox(fe2.id)[0];
  assert.match(toSame.text, /files: src\/api\.ts\)/, "short path within the same folder");

  // Delivered in the backend chat: the heading names the folder the work happened in.
  const delivered = handle({ session_id: be.id, hook_event_name: "UserPromptSubmit", cwd: be.cwd, prompt: "what changed?" }, 2)!;
  assert.match(JSON.parse(delivered).hookSpecificOutput.additionalContext, /New in “Frontend chat” \(Claude, \d\d:\d\d, working in \/work\/frontend\)/);
  // In the same folder, no folder note.
  const same = formatDelivery(readInbox(fe2.id), undefined, "/work/frontend");
  assert.doesNotMatch(same, /working in/);
});

test("connect-time context: full paths when the other chat is in another folder", () => {
  const digest = { messages: [{ id: "1", who: "you" as const, text: "Build it" }, { id: "2", who: "ai" as const, text: "Built." }], filesChanged: ["/work/frontend/src/app.tsx"] };
  const from = { id: "x", tool: "Claude" as const, title: "FE", cwd: "/work/frontend" };
  assert.match(buildContext({ from, digest, root: "/work/frontend" }), /Files that chat changed: src\/app\.tsx/);
  assert.match(buildContext({ from, digest, root: "/work/frontend", absolute: true }), /Files that chat changed: \/work\/frontend\/src\/app\.tsx/);
});

test("context from a chat elsewhere names its folder in the heading", () => {
  appendInbox("b", { from: { id: "a", tool: "Codex", title: "API tests", cwd: "/work/backend" }, at: Date.now(), kind: "context", text: "…" });
  assert.match(formatDelivery(readInbox("b"), undefined, "/work/frontend"), /The chat “API tests” \(Codex, working in \/work\/backend\), now connected/);
});

test("gemini: every folder's chats are listed, each with its own folder", async () => {
  const home = tmp("crosstalk-gemini-all-");
  const tmpDir = path.join(home, "tmp");
  process.env.CROSSTALK_GEMINI_TMP = tmpDir;
  const day = new Date().toISOString();
  for (const [slug, folder, id] of [["frontend", "/work/frontend", "g-fe"], ["backend", "/work/backend", "g-be"]]) {
    fs.mkdirSync(path.join(tmpDir, slug, "chats"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, slug, ".project_root"), folder);
    fs.writeFileSync(path.join(tmpDir, slug, "chats", `session-${id}.jsonl`), [j({ sessionId: id, startTime: day }), j({ id: "u", type: "user", content: [{ text: `Hello from ${slug}` }] })].join("\n"));
  }
  // An old hash folder with no marker can't be placed: left to its own folder's view.
  fs.mkdirSync(path.join(tmpDir, "0".repeat(64), "chats"), { recursive: true });
  const all = await new GeminiAdapter().list(undefined, 50);
  assert.deepEqual(all.map((s) => `${s.id}@${s.cwd}`).sort(), ["g-be@/work/backend", "g-fe@/work/frontend"]);
  assert.deepEqual((await new GeminiAdapter().list("/work/backend", 50)).map((s) => s.id), ["g-be"]);
  delete process.env.CROSSTALK_GEMINI_TMP;
});

test("codex: with no folder, rollouts of every folder are listed", async () => {
  const home = tmp("crosstalk-codex-all-");
  process.env.CODEX_HOME = home;
  const dir = path.join(home, "sessions", "2026", "11", "12");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, cwd] of [["11111111-0000-4000-8000-000000000000", "/work/frontend"], ["22222222-0000-4000-8000-000000000000", "/work/backend"]]) {
    fs.writeFileSync(
      path.join(dir, `rollout-2026-11-12T10-00-00-${id}.jsonl`),
      [j({ type: "session_meta", payload: { id, cwd, timestamp: new Date().toISOString() } }), j({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: `work in ${cwd}` }] } })].join("\n") + "\n",
    );
  }
  const a = new CodexAdapter();
  assert.equal((await a.list(undefined, 50)).length, 2);
  assert.equal((await a.list("/work/backend", 50)).length, 1);
  delete process.env.CODEX_HOME;
});

test("claude: real chats of every folder list fast, and their model comes from the file's end", { skip: !fs.existsSync(claudeProjectsDir()) && "no Claude history here" }, async () => {
  const a = new ClaudeAdapter();
  const t = Date.now();
  const all = await a.list(undefined, 400);
  assert.ok(Date.now() - t < 5000, "listing every folder stays quick");
  assert.ok(new Set(all.map((s) => s.cwd)).size >= 1);
  const recent = all.slice(0, 10);
  const t2 = Date.now();
  const models = recent.map((s) => a.latest(s)?.model).filter(Boolean);
  assert.ok(Date.now() - t2 < 3000, "reading only the end of each file is quick, even for huge chats");
  assert.ok(models.length > 0);
});

test("temp folders (tests, scratch runs) are recognised; real ones are not", () => {
  assert.equal(isTempFolder(os.tmpdir()), true);
  assert.equal(isTempFolder(path.join(os.tmpdir(), "x", "work")), true);
  assert.equal(isTempFolder("/private/tmp/claude-501/scratch/e2e/work"), true);
  assert.equal(isTempFolder(path.join(os.homedir(), "Mine", "Work", "crosstalk")), false);
});

test("open in its folder: only that folder's window takes the request, once; stale ones are dropped", () => {
  const now = Date.now();
  addOpenRequest({ id: "be-chat", tool: "Claude", cwd: "/work/backend", at: now });
  addOpenRequest({ id: "fe-chat", tool: "Codex", cwd: "/work/frontend", at: now });
  addOpenRequest({ id: "old", tool: "Claude", cwd: "/work/backend", at: now - 10 * 60_000 });
  assert.deepEqual(takeOpenRequests("/work/elsewhere", now), []);
  assert.deepEqual(takeOpenRequests("/work/backend", now).map((r) => r.id), ["be-chat"], "fresh ones only");
  assert.deepEqual(takeOpenRequests("/work/backend", now), [], "taken once");
  assert.deepEqual(takeOpenRequests("/work/frontend", now).map((r) => r.id), ["fe-chat"]);
});

test("open in its folder: any of the window's folders takes it, a symlinked path too; one no window took can be withdrawn", () => {
  const now = Date.now();
  const real = tmp("crosstalk-real-");
  const link = path.join(tmp("crosstalk-link-"), "linked");
  fs.symlinkSync(real, link);
  addOpenRequest({ id: "via-link", tool: "Claude", cwd: link, at: now });
  addOpenRequest({ id: "second-folder", tool: "Codex", cwd: "/work/docs", at: now });
  addOpenRequest({ id: "nobody", tool: "Claude", cwd: "/work/nowhere", at: now });
  assert.deepEqual(takeOpenRequests([real], now).map((r) => r.id), ["via-link"], "the same folder by another path");
  assert.deepEqual(takeOpenRequests(["/work/app", "/work/docs"], now).map((r) => r.id), ["second-folder"], "a window's second folder");
  assert.equal(dropOpenRequest("nobody"), true, "still waiting: withdrawn");
  assert.equal(dropOpenRequest("nobody"), false, "only once");
  assert.equal(dropOpenRequest("via-link"), false, "a taken one is not there to withdraw");
});
