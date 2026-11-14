import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildContext, buildUpdate, formatDelivery } from "../src/core/updates";
import type { ChatMessage, InboxItem } from "../src/core/types";

const from = { id: "a", tool: "Claude" as const, title: "Billing fix" };
const msgs: ChatMessage[] = [
  { id: "1", who: "you", text: "Checkout must show the price from the server." },
  { id: "2", who: "ai", text: "Done. Changed lib/useSubscribe.ts." },
  { id: "3", who: "you", text: "Captions overlap the progress bar." },
  { id: "4", who: "ai", text: "Moved the caption layer up.\n\nIt now sits above the bar." },
];

beforeEach(() => {
  process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-upd-"));
});

test("context is the conversation itself, files, and where the whole of it is", () => {
  const text = buildContext({ from, digest: { messages: msgs, filesChanged: ["/repo/lib/a.ts", "/x/b.ts"] }, pointer: "Its record: crosstalk_flightlog.", root: "/repo" });
  assert.match(text, /\*\*You:\*\* Checkout must show the price from the server\.\n\n\*\*Claude:\*\* Done\./);
  // Replies keep their paragraphs; nothing is cut at this size.
  assert.match(text, /\*\*Claude:\*\* Moved the caption layer up\.\n\nIt now sits above the bar\./);
  assert.match(text, /Files that chat changed: lib\/a\.ts, \/x\/b\.ts/);
  assert.match(text, /Its record: crosstalk_flightlog\./);
});

test("a long chat keeps how it started and as much of the latest as fits", () => {
  const many: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) many.push({ id: `u${i}`, who: "you", text: `ask ${i}` }, { id: `a${i}`, who: "ai", text: `answer ${i} `.repeat(40) });
  const text = buildContext({ from, digest: { messages: many, filesChanged: [] }, budget: 3000 });
  assert.match(text, /ask 0\b/);
  assert.match(text, /ask 39\b/);
  assert.doesNotMatch(text, /ask 20\b/);
  assert.match(text, /exchanges in between are in its flightlog/);
  assert.ok(text.length < 4500);
});

test("an update is the new exchanges in full, and files; nothing new means no update", () => {
  const u = buildUpdate(msgs.slice(2), ["/repo/src/c.tsx"], "/repo", "Claude")!;
  assert.equal(u, "**You:** Captions overlap the progress bar.\n\n**Claude:** Moved the caption layer up.\n\nIt now sits above the bar.\n\nFiles changed: src/c.tsx");
  assert.equal(buildUpdate([], []), undefined);
  const long = buildUpdate([{ id: "x", who: "ai", text: "y".repeat(5000) }], [], undefined, "Claude")!;
  assert.match(long, /the rest: crosstalk_flightlog with its n/);
});

test("a delivery introduces itself, labels each piece and keeps the newest when too long", () => {
  const items: InboxItem[] = [
    { from, at: Date.UTC(2026, 10, 12, 10, 0), kind: "context", text: "OLD ".repeat(400) },
    { from, at: Date.UTC(2026, 10, 12, 11, 0), kind: "update", text: "**Claude:** newest" },
  ];
  const full = formatDelivery(items);
  assert.match(full, /^\[Crosstalk\] The person connected this chat/);
  assert.match(full, /## The chat “Billing fix” \(Claude\), now connected to this one/);
  assert.match(full, /## New in “Billing fix” \(Claude, \d\d:\d\d\)\n\n<crosstalk-data-([0-9a-f]{8})>\n\*\*Claude:\*\* newest\n<\/crosstalk-data-\1>/);
  const short = formatDelivery(items, 200);
  assert.doesNotMatch(short, /OLD/);
  assert.match(short, /1 older piece left out/);
});

test("updates from one chat arrive as one piece under one heading, the latest kept", () => {
  const items: InboxItem[] = Array.from({ length: 11 }, (_, i) => ({ from, at: Date.UTC(2026, 10, 12, 10, i * 5), kind: "update" as const, text: `• ask ${i} → done ${i}` }));
  const text = formatDelivery(items);
  assert.equal(text.match(/## New in “Billing fix”/g)?.length, 1);
  assert.match(text, /\(Claude, \d\d:\d\d–\d\d:\d\d\)/);
  assert.match(text, /3 earlier updates are in its flightlog/);
  assert.doesNotMatch(text, /ask 2 →/);
  assert.match(text, /• ask 3 → done 3\n• ask 4/);
});

test("link changes reach the chat as short notes, with or without other updates", () => {
  const only = formatDelivery([{ from, at: 1, kind: "notice", text: "Unlinked from “Billing fix”: no more updates will come from it." }]);
  assert.match(only, /^\[Crosstalk\] The person changed this chat's channels/);
  assert.match(only, /## Channel changes\n\n• Unlinked from “Billing fix”/);
  const mixed = formatDelivery([
    { from, at: 1, kind: "notice", text: "Resumed: updates from “Billing fix” come again." },
    { from, at: 2, kind: "update", text: "**Claude:** done" },
  ]);
  assert.match(mixed, /## Channel changes\n\n• Resumed/);
  assert.match(mixed, /## New in “Billing fix”/);
});
