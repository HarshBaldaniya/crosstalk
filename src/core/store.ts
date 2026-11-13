// Crosstalk's shared store in ~/.crosstalk, used by both the extension and the hook:
// connections, the inbox of each chat, how far each source chat has been read,
// what was delivered, and branches waiting for their new chat.
// It imports nothing heavy: the hook runs on every message and must start fast.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatRef, Connection, Delivery, InboxItem, PendingBranch } from "./types";
import { readJson, crosstalkFile, safeId, writeFileAtomic } from "./paths";

const PENDING_MS = 30 * 60_000;

// ---- connections ----

/** Levels saved before they were renamed (headlines, summary) are read as today's (ping, brief). */
const OLD_LEVEL: Record<string, Connection["level"]> = { headlines: undefined, summary: "brief" };

export function readConnections(): Connection[] {
  const list = readJson<Connection[]>(crosstalkFile("connections.json"), []);
  for (const c of list) if (c.level && (c.level as string) in OLD_LEVEL) c.level = OLD_LEVEL[c.level as string];
  return list;
}

function writeConnections(list: Connection[]): void {
  writeFileAtomic(crosstalkFile("connections.json"), JSON.stringify(list, null, 2));
}

/** Connects `from` to `to`. Connecting a pair that already exists resumes it. */
export function addConnection(from: ChatRef, to: ChatRef, now = Date.now()): { connection: Connection; created: boolean } {
  const list = readConnections();
  const existing = list.find((c) => c.from.id === from.id && c.to.id === to.id);
  if (existing) {
    existing.paused = false;
    existing.from = from;
    existing.to = to;
    writeConnections(list);
    return { connection: existing, created: false };
  }
  const connection: Connection = { id: randomBytes(6).toString("hex"), from, to, createdAt: now };
  list.push(connection);
  writeConnections(list);
  return { connection, created: true };
}

export function removeConnection(id: string): Connection | undefined {
  const list = readConnections();
  const gone = list.find((c) => c.id === id);
  if (!gone) return undefined;
  writeConnections(list.filter((c) => c.id !== id));
  removeInboxFrom(gone.to.id, gone.from.id);
  return gone;
}

/** How much a link sends (both ways of a two-way link are set together by the caller). */
export function setLevel(ids: string[], level: "ping" | "brief" | "full"): void {
  const list = readConnections();
  for (const c of list) if (ids.includes(c.id)) c.level = level === "ping" ? undefined : level;
  writeConnections(list);
}

export function setPaused(id: string, paused: boolean): void {
  const list = readConnections();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.paused = paused;
  writeConnections(list);
}

// ---- inbox: context waiting to reach a chat ----

function inboxFile(chatId: string): string {
  return crosstalkFile("inbox", `${chatId}.jsonl`);
}

export function appendInbox(chatId: string, item: InboxItem): void {
  if (!safeId(chatId)) return;
  fs.mkdirSync(crosstalkFile("inbox"), { recursive: true });
  fs.appendFileSync(inboxFile(chatId), `${JSON.stringify(item)}\n`);
}

function parseLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line is skipped.
    }
  }
  return out;
}

export function readInbox(chatId: string): InboxItem[] {
  if (!safeId(chatId)) return [];
  try {
    return parseLines<InboxItem>(fs.readFileSync(inboxFile(chatId), "utf8"));
  } catch {
    return [];
  }
}

/** Reads and empties a chat's inbox. Anything appended meanwhile waits for the next message. */
export function takeInbox(chatId: string): InboxItem[] {
  if (!safeId(chatId)) return [];
  const file = inboxFile(chatId);
  const claimed = `${file}.${process.pid}.${Date.now()}.taking`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return [];
  }
  try {
    return parseLines<InboxItem>(fs.readFileSync(claimed, "utf8"));
  } finally {
    fs.rmSync(claimed, { force: true });
  }
}

export function removeInboxFrom(chatId: string, fromId: string): void {
  const kept = readInbox(chatId).filter((i) => i.from.id !== fromId);
  if (!safeId(chatId)) return;
  if (kept.length) writeFileAtomic(inboxFile(chatId), kept.map((i) => JSON.stringify(i)).join("\n") + "\n");
  else fs.rmSync(inboxFile(chatId), { force: true });
}

// ---- cursors: how far each source chat has been read ----

export function getCursor(chatId: string): number | undefined {
  return readJson<Record<string, number>>(crosstalkFile("cursors.json"), {})[chatId];
}

export function setCursor(chatId: string, at: number): void {
  const all = readJson<Record<string, number>>(crosstalkFile("cursors.json"), {});
  all[chatId] = at;
  writeFileAtomic(crosstalkFile("cursors.json"), JSON.stringify(all));
}

/**
 * A reply sent on from the hook's own input (the tool had not written it to its file
 * yet), so it is not sent again when it shows up in the file.
 */
export function getSentReply(chatId: string): string | undefined {
  return readJson<Record<string, string>>(crosstalkFile("replies.json"), {})[chatId];
}

export function setSentReply(chatId: string, text: string | undefined): void {
  const all = readJson<Record<string, string>>(crosstalkFile("replies.json"), {});
  if (text === undefined && !(chatId in all)) return;
  if (text === undefined) delete all[chatId];
  else all[chatId] = text;
  writeFileAtomic(crosstalkFile("replies.json"), JSON.stringify(all));
}

// ---- deliveries: what reached which chat ----

export function logDelivery(d: Delivery): void {
  fs.mkdirSync(crosstalkFile(), { recursive: true });
  fs.appendFileSync(crosstalkFile("deliveries.jsonl"), `${JSON.stringify(d)}\n`);
}

/** The most recent deliveries (the log is only ever read from its tail). */
export function readDeliveries(max = 2000): Delivery[] {
  const file = crosstalkFile("deliveries.jsonl");
  try {
    const size = fs.statSync(file).size;
    const want = Math.min(size, max * 160);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      const lines = parseLines<Delivery>(buf.toString("utf8"));
      return lines.slice(-max);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// ---- branches waiting for their new chat ----

export function readPending(now = Date.now()): PendingBranch[] {
  return readJson<PendingBranch[]>(crosstalkFile("pending.json"), []).filter((p) => now - p.at < PENDING_MS);
}

export function addPending(p: PendingBranch): void {
  writeFileAtomic(crosstalkFile("pending.json"), JSON.stringify([...readPending(), p], null, 2));
}

export function removePending(id: string): void {
  writeFileAtomic(crosstalkFile("pending.json"), JSON.stringify(readPending().filter((p) => p.id !== id), null, 2));
}

/** The branch a new chat's first message belongs to, if any: matched on the start of the task text. */
export function matchPending(prompt: string, cwd: string | undefined, now = Date.now()): PendingBranch | undefined {
  const said = normalise(prompt);
  if (!said) return undefined;
  return readPending(now).find((p) => {
    const start = normalise(p.taskStart).slice(0, 60);
    return start.length > 0 && said.startsWith(start) && (!p.cwd || !cwd || path.resolve(p.cwd) === path.resolve(cwd));
  });
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
