// Where a chat's tokens went: finding against doing, big reads, re-reads, and tips.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderTokenReport, tokenReport } from "../src/core/tokens";

const j = (o: unknown) => JSON.stringify(o) + "\n";
let n = 0;
const use = (name: string, input: Record<string, unknown>, out: string) => {
  const id = `t${++n}`;
  return (
    j({ type: "assistant", message: { id: `m${n}`, role: "assistant", usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 + n, cache_creation_input_tokens: 50 }, content: [{ type: "tool_use", id, name, input }] } }) +
    j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] } })
  );
};

test("a Claude chat: searching and whole-file reads are finding, edits and commands are doing, with tips that name the fix", () => {
  const big = "x".repeat(40_000);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-tok-")), "c.jsonl");
  fs.writeFileSync(
    file,
    use("Grep", { pattern: "upload" }, "y".repeat(8000)) +
      use("Bash", { command: "cd /repo && grep -rn tray src" }, "z".repeat(8000)) +
      use("Read", { file_path: "/repo/src/Tray.tsx" }, big) +
      use("Read", { file_path: "/repo/src/Tray.tsx", offset: 10, limit: 20 }, "a".repeat(400)) +
      use("Read", { file_path: "/repo/src/Tray.tsx" }, big) +
      use("Edit", { file_path: "/repo/src/Tray.tsx" }, "ok") +
      use("Bash", { command: "npm test" }, "b".repeat(4000)),
  );
  const r = tokenReport("claude", file);
  assert.equal(r.replies, 7);
  assert.equal(r.byKind.finding, 2000 + 2000 + 10_000 + 100 + 10_000);
  assert.equal(r.byKind.doing, 1001);
  assert.deepEqual(r.bigReads, [{ file: "/repo/src/Tray.tsx", tokens: 10_000 }]);
  assert.deepEqual(r.rereads, [{ file: "/repo/src/Tray.tsx", times: 3, tokens: 20_100 }]);
  const text = renderTokenReport(r, "Upload work");
  assert.match(text, /^Upload work: 7 replies, 700 written/);
  assert.match(text, /finding 96%/);
  assert.match(text, /crosstalk_map with find answers "where is X" in about 250 tokens/);
  assert.match(text, /1 whole-file read over 4k tokens \(largest: src\/Tray\.tsx, 10k\)/);
  assert.match(text, /src\/Tray\.tsx was read 3 times/);
});

test("a Codex chat: function calls and their output, and its own token totals", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-tok-")), "rollout.jsonl");
  fs.writeFileSync(
    file,
    j({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "rg -n tray"] }) } }) +
      j({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "x".repeat(4000) } }) +
      j({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 700 }, last_token_usage: { input_tokens: 4000, output_tokens: 100 } } } }),
  );
  const r = tokenReport("codex", file);
  assert.equal(r.byKind.finding, 1000);
  assert.deepEqual([r.input, r.cacheRead, r.output, r.contextNow], [2000, 3000, 700, 4100]);
});
