// Codex and Gemini CLI, as their installed versions behave (Codex 0.167, Gemini CLI 0.68):
// their chat files, their hook events and the outputs they accept.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connect, hookCommandFor, hookTargets, staleHookTargets } from "../src/core/hooks";
import { handle } from "../src/hook/crosstalk-hook";
import { addConnection, appendInbox, getCursor, readInbox, setCursor } from "../src/core/store";
import { GeminiAdapter, geminiChatDirs, loadGeminiChat } from "../src/adapters/gemini";
import { codexMessages } from "../src/adapters/codex";
import { statusDir } from "../src/core/paths";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const j = (o: unknown) => JSON.stringify(o);

beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-home-");
  process.env.CROSSTALK_CLAUDE_SETTINGS = path.join(tmp("crosstalk-claude-"), "settings.json");
});

/** A Gemini CLI 0.68 home: ~/.gemini/projects.json names the folder, chats are .jsonl. */
function geminiHome(root: string, slug = "app") {
  const home = tmp("crosstalk-gemini-home-");
  const chats = path.join(home, "tmp", slug, "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(home, "projects.json"), j({ projects: { [root]: slug } }));
  fs.writeFileSync(path.join(home, "tmp", slug, ".project_root"), root);
  process.env.CROSSTALK_GEMINI_TMP = path.join(home, "tmp");
  return { home, chats };
}

const day = new Date().toISOString();
const gUser = (id: string, text: string) => j({ id, timestamp: day, type: "user", content: [{ text }] });
const gAi = (id: string, text: string, extra: object = {}) => j({ id, timestamp: day, type: "gemini", content: text, ...extra });

test("gemini 0.68: chats are found through projects.json and read from .jsonl, edits and rewinds applied", async () => {
  const root = "/work/app";
  const { chats } = geminiHome(root);
  const file = path.join(chats, "session-2026-11-12T10-00-abcd1234.jsonl");
  fs.writeFileSync(
    file,
    [
      j({ sessionId: "abcd1234-0000-4000-8000-000000000000", projectHash: "x", startTime: day, lastUpdated: day, kind: "main" }),
      gUser("u1", "Write the README"),
      gAi("a1", "Writing it."),
      // The same reply again, now with its tokens and model: the newer copy wins, in its place.
      gAi("a1", "Done.", { model: "gemini-3-pro", tokens: { input: 500, output: 40, cached: 200, thoughts: 10 }, toolCalls: [{ name: "write_file", args: { file_path: "/work/app/README.md" } }] }),
      j({ $set: { lastUpdated: day } }),
      gUser("u2", "Oops, wrong"),
      gAi("a2", "Undone soon"),
      j({ $rewindTo: "u2" }),
      gUser("u3", "Add a licence"),
      j({ $patch: { updates: [{ id: "u3", content: [{ text: "Add an MIT licence" }] }] } }),
      '{"id":"half', // a line still being written
    ].join("\n"),
  );
  const g = new GeminiAdapter();
  const list = await g.list(root, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "abcd1234-0000-4000-8000-000000000000");
  assert.equal(list[0].title, "Write the README");
  const d = await g.read(list[0]);
  assert.deepEqual(
    d.messages.map((m) => m.text),
    ["Write the README", "Done.", "Add an MIT licence"],
  );
  assert.deepEqual(d.filesChanged, ["/work/app/README.md"]);
  assert.equal(g.usage(list[0])?.model, "gemini-3-pro");
  assert.equal(g.end(list[0]), 3);
  delete process.env.CROSSTALK_GEMINI_TMP;
});

test("gemini: the folder is also found by its .project_root, and the old hash folder still counts", () => {
  const root = "/work/other";
  const { home } = geminiHome(root, "other");
  fs.rmSync(path.join(home, "projects.json"));
  const dirs = geminiChatDirs(root);
  assert.equal(dirs[0], path.join(home, "tmp", "other", "chats"));
  assert.ok(dirs.length >= 2); // and the pre-0.4x SHA-256 folder
  delete process.env.CROSSTALK_GEMINI_TMP;
});

test("gemini: a chat moved from .json to .jsonl is listed once", async () => {
  const root = "/work/app";
  const { chats } = geminiHome(root);
  const id = "abcd1234-0000-4000-8000-000000000000";
  fs.writeFileSync(path.join(chats, "session-old-abcd1234.json"), j({ sessionId: id, startTime: day, messages: [{ id: "u1", type: "user", content: "Hi" }] }));
  fs.writeFileSync(path.join(chats, "session-new-abcd1234.jsonl"), [j({ sessionId: id, startTime: day }), gUser("u1", "Hi")].join("\n"));
  assert.equal((await new GeminiAdapter().list(root, 10)).length, 1);
  delete process.env.CROSSTALK_GEMINI_TMP;
});

test("gemini hook: BeforeAgent gets the waiting context, AfterAgent sends the reply on and continues with new updates", () => {
  const root = "/work/app";
  const { chats } = geminiHome(root);
  const file = path.join(chats, "session-x-gem12345.jsonl");
  const gem = { id: "gem12345-0000-4000-8000-000000000000", tool: "Gemini" as const, title: "Gemini chat" };
  const claude = { id: "cla12345-0000-4000-8000-000000000000", tool: "Claude" as const, title: "Claude chat" };
  addConnection(gem, claude);
  addConnection(claude, gem);
  fs.writeFileSync(file, [j({ sessionId: gem.id, startTime: day }), gUser("u1", "Plan the API")].join("\n") + "\n");
  setCursor(gem.id, 1);

  // These check delivery as a reply ends, which is off unless chosen.
  fs.writeFileSync(path.join(process.env.CROSSTALK_HOME!, "config.json"), JSON.stringify({ autoDeliver: true }));
  // A message arrives in Gemini with an update waiting: BeforeAgent hands it over.
  appendInbox(gem.id, { from: claude, at: 1, kind: "update", text: "Claude renamed /users to /accounts." });
  const before = JSON.parse(handle({ session_id: gem.id, transcript_path: file, hook_event_name: "BeforeAgent", cwd: root, prompt: "Plan the API" }, 2, "gemini")!);
  assert.equal(before.hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.match(before.hookSpecificOutput.additionalContext, /accounts/);
  assert.equal(readInbox(gem.id).length, 0);

  // Gemini replies; meanwhile Claude sent something else.
  fs.appendFileSync(file, gAi("a1", "Here is the plan.") + "\n");
  appendInbox(gem.id, { from: claude, at: 3, kind: "update", text: "Claude added rate limits." });
  const after = JSON.parse(handle({ session_id: gem.id, transcript_path: file, hook_event_name: "AfterAgent", cwd: root, stop_hook_active: false }, 4, "gemini")!);
  assert.equal(after.decision, "block");
  assert.match(after.reason, /rate limits/);
  assert.match(readInbox(claude.id)[0].text, /Here is the plan/);

  // Gemini continues with Crosstalk's note as the next message; that turn is skipped, never sent back.
  fs.appendFileSync(file, gUser("u2", after.reason) + "\n" + gAi("a2", "Noted the updates from linked chats.") + "\n");
  assert.equal(handle({ session_id: gem.id, transcript_path: file, hook_event_name: "AfterAgent", cwd: root, stop_hook_active: true }, 5, "gemini"), undefined);
  assert.equal(readInbox(claude.id).length, 1);
  assert.equal(getCursor(gem.id), 4); // u1, a1, the note, the reply
  delete process.env.CROSSTALK_GEMINI_TMP;
});

test("gemini: Crosstalk's own note in the chat is never read as something the person said", () => {
  const file = path.join(tmp("crosstalk-g-"), "s.jsonl");
  fs.writeFileSync(file, [j({ sessionId: "s" }), gUser("u1", "[Crosstalk] The person connected this chat…"), gAi("a1", "Noted the updates from linked chats.")].join("\n"));
  assert.equal(loadGeminiChat(file)?.messages?.length, 2);
  assert.deepEqual(new GeminiAdapter()["load"](file, 0)?.messages?.length, 2);
});

test("codex hook: PermissionRequest is 'needs you', Stop sends on and continues, Crosstalk's notes are left out", () => {
  const dir = tmp("crosstalk-codex-");
  const file = path.join(dir, "rollout-2026-11-12T10-00-00-cod12345-0000-4000-8000-000000000000.jsonl");
  const codex = { id: "cod12345-0000-4000-8000-000000000000", tool: "Codex" as const, title: "Codex chat" };
  const claude = { id: "cla12345-0000-4000-8000-000000000000", tool: "Claude" as const, title: "Claude chat" };
  addConnection(codex, claude);
  const msg = (role: string, text: string) => j({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } }) + "\n";
  fs.writeFileSync(file, j({ type: "session_meta", payload: { id: codex.id, cwd: "/work/app" } }) + "\n");
  setCursor(codex.id, fs.statSync(file).size);

  handle({ session_id: codex.id, transcript_path: file, hook_event_name: "PermissionRequest", cwd: "/work/app" }, 1, "codex");
  assert.equal(JSON.parse(fs.readFileSync(path.join(statusDir(), `${codex.id}.json`), "utf8")).status, "waiting");

  fs.writeFileSync(path.join(process.env.CROSSTALK_HOME!, "config.json"), JSON.stringify({ autoDeliver: true }));
  fs.appendFileSync(file, msg("user", "Add dark mode") + msg("user", "[Crosstalk] Linked chats sent the updates above…") + msg("assistant", "Dark mode added."));
  appendInbox(codex.id, { from: claude, at: 2, kind: "update", text: "Claude changed the colours." });
  const out = JSON.parse(handle({ session_id: codex.id, transcript_path: file, hook_event_name: "Stop", cwd: "/work/app", stop_hook_active: false }, 3, "codex")!);
  // Codex's stop.command.output allows only these keys (additionalProperties: false).
  assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
  const sent = readInbox(claude.id)[0].text;
  assert.match(sent, /Dark mode added/);
  assert.doesNotMatch(sent, /\[Crosstalk\]/);
  assert.equal(handle({ session_id: codex.id, transcript_path: file, hook_event_name: "SessionEnd" }, 4, "codex"), undefined);
});

test("codex: a null transcript_path is handled", () => {
  addConnection({ id: "c1", tool: "Codex", title: "a" }, { id: "c2", tool: "Claude", title: "b" });
  assert.equal(handle({ session_id: "c1", transcript_path: null as unknown as string, hook_event_name: "Stop" }, 1, "codex"), undefined);
});

test("codexMessages leaves out Crosstalk's deliveries and keeps the person's words", () => {
  const row = (role: string, text: string) => j({ type: "response_item", payload: { type: "message", role, content: [{ text }] } });
  const { messages } = codexMessages([row("user", "Ship it"), row("user", "[Crosstalk] New in “X”"), row("assistant", "Noted the updates from linked chats."), row("assistant", "Shipped.")]);
  assert.deepEqual(messages.map((m) => m.text), ["Ship it", "Shipped."]);
});

test("hook targets: each agent's events; Gemini counts as installed only with Gemini CLI's own files", () => {
  const home = tmp("crosstalk-gh-");
  process.env.CROSSTALK_GEMINI_HOME = home;
  fs.mkdirSync(path.join(home, "antigravity"));
  const gemini = () => hookTargets().find((t) => t.tool === "Gemini")!;
  assert.equal(gemini().present(), false);
  fs.mkdirSync(path.join(home, "tmp"));
  assert.equal(gemini().present(), true);
  assert.deepEqual([...gemini().events], ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool", "Notification", "SessionEnd"]);
  assert.equal(gemini().timeout, 5000); // Gemini CLI's timeouts are milliseconds
  assert.ok(hookTargets().find((t) => t.tool === "Codex")!.events.includes("SessionEnd"));
  delete process.env.CROSSTALK_GEMINI_HOME;
});

test("a hook whose node is gone, or that can fail, is found for repair; the new command always ends cleanly", () => {
  const home = tmp("crosstalk-codex-home-");
  process.env.CODEX_HOME = home;
  const codex = () => hookTargets().find((t) => t.tool === "Codex")!;
  connect('"/no/such/node" "/h/.crosstalk/crosstalk-hook.js" codex', codex().file, codex().events, 5);
  assert.ok(staleHookTargets().some((t) => t.tool === "Codex"));
  const cmd = hookCommandFor(process.execPath, "Codex");
  assert.ok(cmd.endsWith(" codex || true"));
  connect(cmd, codex().file, codex().events, 5);
  assert.deepEqual(staleHookTargets().map((t) => t.tool).filter((t) => t === "Codex"), []);
  delete process.env.CODEX_HOME;
});

test("claude: the reply that just ended goes out with Stop even before it is in the file, and only once", () => {
  const dir = tmp("crosstalk-late-");
  const file = path.join(dir, "a.jsonl");
  const a = { id: "aaaa1111-0000-4000-8000-000000000000", tool: "Claude" as const, title: "A" };
  const b = { id: "bbbb1111-0000-4000-8000-000000000000", tool: "Claude" as const, title: "B" };
  addConnection(a, b);
  const row = (type: string, uuid: string, text: string) =>
    j({ type, uuid, message: type === "user" ? { role: "user", content: text } : { id: `m-${uuid}`, role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  fs.writeFileSync(file, "");
  setCursor(a.id, 0);
  // Stop fires: the question is in the file, the reply is not yet.
  fs.appendFileSync(file, row("user", "u1", "Which database?"));
  handle({ session_id: a.id, transcript_path: file, hook_event_name: "Stop", last_assistant_message: "Postgres." }, 1);
  assert.equal(readInbox(b.id)[0].text, "• Which database? → Postgres.");
  // Next turn: the late reply is now in the file, ahead of the new exchange. It is not sent twice.
  fs.appendFileSync(file, row("assistant", "a1", "Postgres.") + row("user", "u2", "And the cache?"));
  handle({ session_id: a.id, transcript_path: file, hook_event_name: "Stop", last_assistant_message: "Redis." }, 2);
  const second = readInbox(b.id)[1].text;
  assert.doesNotMatch(second, /Postgres/);
  assert.match(second, /And the cache\?[\s\S]*Redis\./);
});
