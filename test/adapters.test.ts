import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { claudeMessages, claudeUsage, readLinesFrom } from "../src/core/transcript";
import { CodexAdapter, codexMessages, codexUsage } from "../src/adapters/codex";
import { GeminiAdapter } from "../src/adapters/gemini";
import { ClaudeAdapter } from "../src/adapters/claude";
import { claudeProjectFolder } from "../src/core/paths";
import type { Usage } from "../src/core/types";

const j = (o: unknown) => JSON.stringify(o);

test("transcript: unfinished last lines wait for next time", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-t-")), "t.jsonl");
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  const r = readLinesFrom(f, 0);
  assert.deepEqual(r.lines, ['{"a":1}']);
  assert.equal(r.next, 8);
  fs.appendFileSync(f, "2}\n");
  assert.deepEqual(readLinesFrom(f, r.next).lines, ['{"b":2}']);
});

test("claude: machinery, summaries, meta and subagents are left out; usage counts each message once", () => {
  const lines = [
    j({ type: "user", uuid: "1", message: { content: "Fix it <system-reminder>x</system-reminder>" } }),
    j({ type: "user", uuid: "2", isCompactSummary: true, message: { content: "This session is being continued from a previous conversation" } }),
    j({ type: "user", uuid: "3", isMeta: true, message: { content: "meta" } }),
    j({ type: "user", uuid: "4", message: { content: "<artifact-content-authored-by-others/>The summarized conversation included…" } }),
    j({ type: "assistant", uuid: "5", timestamp: "2026-11-12T10:00:00Z", message: { id: "m1", content: [{ type: "text", text: "On it." }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 } } }),
    j({ type: "assistant", uuid: "6", timestamp: "2026-11-12T10:00:01Z", message: { id: "m1", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/a.ts" } }], usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100 } } }),
  ];
  const { messages, files } = claudeMessages(lines);
  assert.deepEqual(messages.map((m) => [m.who, m.text]), [["you", "Fix it"], ["ai", "On it."]]);
  assert.deepEqual(files, ["/r/a.ts"]);
  const by = new Map<string, { u: Usage; day: string }>();
  claudeUsage(lines, by);
  assert.deepEqual([...by.values()], [{ u: { input: 10, output: 7, cacheRead: 100, cacheWrite: 0 }, day: "2026-11-12" }]);
});

test("codex: rollouts in this folder are listed and read; usage comes from the running totals", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-codex-"));
  process.env.CODEX_HOME = home;
  const day = path.join(home, "sessions", "2026", "11", "12");
  fs.mkdirSync(day, { recursive: true });
  const id = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
  const rows = [
    { timestamp: "2026-11-11T09:00:00Z", type: "session_meta", payload: { id, cwd: "/work/app", timestamp: "2026-11-11T09:00:00Z", git: { branch: "main" } } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context><cwd>/work/app</cwd></environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a dark mode toggle" }] } },
    { type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/theme.ts\n" } },
    { timestamp: "2026-11-11T09:01:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, total_tokens: 1050 } } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added the toggle." }] } },
    { timestamp: "2026-11-12T09:01:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 150, total_tokens: 3150 } } } },
  ];
  fs.writeFileSync(path.join(day, `rollout-2026-11-11T09-00-00-${id}.jsonl`), rows.map(j).join("\n") + "\n");
  fs.writeFileSync(path.join(day, `rollout-2026-11-11T09-00-00-0199aaaa-0000-4000-8000-000000000000.jsonl`), j({ type: "session_meta", payload: { id: "other", cwd: "/elsewhere" } }) + "\n");

  const codex = new CodexAdapter();
  assert.ok(codex.present());
  const chats = await codex.list("/work/app", 10);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, id);
  assert.equal(chats[0].title, "Add a dark mode toggle");
  assert.equal(chats[0].branch, "main");
  const d = await codex.read(chats[0]);
  assert.deepEqual(d.messages.map((m) => m.text), ["Add a dark mode toggle", "Added the toggle."]);
  assert.deepEqual(d.filesChanged, ["src/theme.ts"]);
  assert.equal(codex.resumeCommand(chats[0]), `codex resume ${id}`);

  const u = codexUsage(rows.map(j), "2026-11-12");
  assert.deepEqual(u.total, { input: 2000, output: 150, cacheRead: 1000, cacheWrite: 0 });
  assert.deepEqual(u.today, { input: 1400, output: 100, cacheRead: 600, cacheWrite: 0 });
  assert.equal(codexMessages(rows.slice(5).map(j)).messages[0].text, "Added the toggle.");
  delete process.env.CODEX_HOME;
});

test("gemini: chats for this folder's hash are listed, read and counted", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-gemini-"));
  process.env.CROSSTALK_GEMINI_TMP = tmpDir;
  // The folder as Gemini CLI sees it: on Windows "/work/app" is "D:\work\app", and that is what it hashes.
  const root = path.resolve("/work/app");
  const chats = path.join(tmpDir, createHash("sha256").update(root).digest("hex"), "chats");
  fs.mkdirSync(chats, { recursive: true });
  const day = new Date().toISOString();
  fs.writeFileSync(
    path.join(chats, "session-1.json"),
    j({
      sessionId: "g-123",
      startTime: day,
      messages: [
        { id: "1", timestamp: day, type: "user", content: "Write the README" },
        { id: "2", timestamp: day, type: "gemini", content: "Done.", tokens: { input: 500, output: 40, cached: 200, thoughts: 10 }, toolCalls: [{ name: "write_file", args: { file_path: path.join(root, "README.md") } }] },
      ],
    }),
  );
  const g = new GeminiAdapter();
  const list = await g.list(root, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Write the README");
  const d = await g.read(list[0]);
  assert.deepEqual(d.messages.map((m) => m.who), ["you", "ai"]);
  assert.deepEqual(d.filesChanged, [path.join(root, "README.md")]);
  assert.deepEqual(g.usage(list[0])?.today, { input: 300, output: 50, cacheRead: 200, cacheWrite: 0 });
  assert.equal(g.end(list[0]), 2);
  assert.equal(g.since(list[0], 1).messages[0].text, "Done.");
  delete process.env.CROSSTALK_GEMINI_TMP;
});

// Against this computer's real Claude chats, through the bundled SDK.
const here = process.env.CROSSTALK_TEST_DIR || process.cwd();
test("claude: real chats list, read and count tokens", { skip: !fs.existsSync(claudeProjectFolder(here)) && "no saved Claude chats for the test folder" }, async () => {
  const c = new ClaudeAdapter();
  const list = await c.list(here, 5);
  assert.ok(list.length > 0);
  assert.ok(list[0].file && fs.existsSync(list[0].file));
  const d = await c.read(list[0], here);
  assert.ok(d.messages.length > 0);
  const u = c.usage(list[0]);
  assert.ok(u && u.total.output > 0);
  assert.equal(c.end(list[0]), fs.statSync(list[0].file!).size);
});

import { claudeLatest } from "../src/core/transcript";
import { contextWindow } from "../src/core/types";
import { resolveStatus } from "../src/core/status";

test("model and context: Claude's latest main reply, not a subagent's", () => {
  const lines = [
    j({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2000, output_tokens: 500 } } }),
    j({ type: "assistant", isSidechain: true, message: { id: "m2", model: "claude-haiku-5-5", usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];
  assert.deepEqual(claudeLatest(lines), { model: "claude-opus-5-5", used: 302_510 });
  assert.equal(contextWindow("claude-opus-5-5"), 1_000_000);
  assert.equal(contextWindow("claude-haiku-4-5-20251001"), 200_000);
});

test("model and context: Codex turn_context and token_count", () => {
  const u = codexUsage(
    [
      j({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
      j({ timestamp: "2026-11-12T09:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 }, last_token_usage: { input_tokens: 40_000, output_tokens: 1000 }, model_context_window: 272_000 } } }),
    ],
    "2026-11-12",
  );
  assert.equal(u.model, "gpt-5-codex");
  assert.deepEqual(u.context, { used: 41_000, window: 272_000 });
});

test("status: a hook record older than the chat's own activity is ignored", () => {
  const now = 100 * 60_000;
  // The chat wrote just now, but the hook last said "done" an hour ago: it is working.
  assert.equal(resolveStatus(now - 2_000, { status: "done", at: now - 60 * 60_000, event: "Stop" }, now).status, "working");
});

test("claude: real chats carry their model and context", { skip: !fs.existsSync(claudeProjectFolder(here)) && "no saved Claude chats" }, async () => {
  const c = new ClaudeAdapter();
  const [chat] = await c.list(here, 1);
  const u = c.usage(chat)!;
  assert.match(u.model ?? "", /^claude-/);
  assert.ok(u.context && u.context.used > 0 && u.context.window >= 200_000);
});
