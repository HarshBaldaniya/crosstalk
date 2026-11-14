// The session record: one short line per thing the person asked in a chat, what was done about
// it, the files it changed, the commits and PRs it mentioned, and anything left open. Written by
// code from the chat's own file (no AI), a few hundred bytes per ask, never a copy of the
// conversation: the exact words stay in the agent's file, found again through `src`.
//
//   ~/.crosstalk/sessions/<id>.json    where the record has read up to, and what the chat is
//   ~/.crosstalk/sessions/<id>.jsonl   one line per ask, appended
import { redact } from "./redact";
import * as fs from "node:fs";
import * as path from "node:path";
import { codexMessages } from "../adapters/codex";
import { geminiMessages, loadGeminiChat } from "../adapters/gemini";
import { claudeProjectsDir, codexSessionsDir, crosstalkFile, geminiTmpDir, readJson, safeId, writeFileAtomic } from "./paths";
import { claudeMessages, fileSize, readLinesFrom } from "./transcript";
import { fullPath, relativeTo } from "./updates";
import type { ChatMessage, Tool } from "./types";

export type RecordTool = "claude" | "codex" | "gemini";

export interface RecordAsk {
  n: number;
  at: number;
  /** The person's words (long pastes shortened, with how much was left out). */
  ask: string;
  /** What was done: the reply's first paragraph, which says the outcome. */
  did: string;
  /** A question or "Next:" the reply ended on. */
  open?: string;
  files: string[];
  /** Commits, PRs and links mentioned in the reply or in what its commands printed. */
  refs: string[];
  /** Where this exchange is in the agent's file: byte offsets (Claude, Codex) or message indexes (Gemini). */
  src: [number, number];
}

export interface RecordHead {
  id: string;
  tool: RecordTool;
  title?: string;
  cwd?: string;
  /** The agent's own chat file. */
  file: string;
  /** Read up to here (in the file's own units). */
  cursor: number;
  /** Asks recorded. */
  n: number;
  /** The first thing asked: what the chat set out to do. */
  goal?: string;
  updatedAt: number;
}

const ASK_MAX = 600;
const DID_MAX = 400;
const OPEN_MAX = 200;
const REFS_MAX = 8;
/** A new chat's record is started by the hook; an older, bigger one is caught up in the background. */
export const HOOK_START_MAX = 8 * 1024 * 1024;
/** The most the hook reads in one go: more is left to the background catch-up. */
export const HOOK_STEP_MAX = 16 * 1024 * 1024;

const dir = () => crosstalkFile("flightlogs");
const headFile = (id: string) => path.join(dir(), `${id}.json`);
const asksFile = (id: string) => path.join(dir(), `${id}.jsonl`);

export const toolOf = (t: Tool | string): RecordTool => (/codex/i.test(t) ? "codex" : /gemini/i.test(t) ? "gemini" : "claude");
export const toolName = (t: RecordTool): Tool => (t === "codex" ? "Codex" : t === "gemini" ? "Gemini" : "Claude");

export function readHead(id: string): RecordHead | undefined {
  if (!safeId(id)) return undefined;
  return readJson<RecordHead | undefined>(headFile(id), undefined);
}

function writeHead(h: RecordHead): void {
  fs.mkdirSync(dir(), { recursive: true });
  writeFileAtomic(headFile(h.id), JSON.stringify(h));
}

/** Every recorded ask, or the last `last` of them. */
export function readAsks(id: string, last?: number): RecordAsk[] {
  if (!safeId(id)) return [];
  let text: string;
  try {
    text = fs.readFileSync(asksFile(id), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean);
  const out: RecordAsk[] = [];
  for (const l of last ? lines.slice(-last) : lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // A line cut short by a crash: skipped.
    }
  }
  return out;
}

/** All records kept on this computer, newest first. */
export function listHeads(): RecordHead[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((f) => readJson<RecordHead | undefined>(path.join(dir(), f), undefined))
    .filter((h): h is RecordHead => !!h)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Names a record (the extension knows titles; the hook doesn't). */
export function setRecordTitle(id: string, title: string, cwd?: string): void {
  const h = readHead(id);
  if (h && (h.title !== title || (cwd && h.cwd !== cwd))) writeHead({ ...h, title, cwd: cwd ?? h.cwd });
}

/** Deletes records not touched for `days` days, except those of chats still linked. */
export function pruneRecords(keep: Set<string>, days = 30, now = Date.now()): number {
  let gone = 0;
  for (const h of listHeads()) {
    if (keep.has(h.id) || now - h.updatedAt < days * 86_400_000) continue;
    for (const f of [headFile(h.id), asksFile(h.id)]) fs.rmSync(f, { force: true });
    gone++;
  }
  return gone;
}

// ---- reading a chat's file into asks ----

/** One exchange as read: the ask, the reply, and what happened in between. */
interface Exchange {
  ask: string;
  /** Every message of the reply, in order: the last one is the answer, the rest progress notes. */
  reply: string;
  last: string;
  files: Set<string>;
  refs: Set<string>;
  at: number;
  start: number;
  end: number;
}

const PR_URL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const PR_WORD = /\b(?:PR|pull request) #(\d{1,6})\b/gi;
/**
 * What `git commit` prints: "[branch abc1234] message", then " 2 files changed". Both are needed,
 * so a file that merely contains "[branch abc1234]" (read by a command) doesn't count. In a raw chat
 * line the newline between them is written as "\n".
 */
const COMMIT_LINE = /\[[\w./-]+ ([0-9a-f]{7,12})\][^\[]{0,300}?(?:\n|\\n) ?\d+ files? changed/g;
/** A hash quoted in a reply: `87aa2f750`. */
const COMMIT_QUOTED = /`([0-9a-f]{7,12})`/g;

/**
 * Commits and PRs: from a reply, as it names them; from what a command printed (`raw`), only git's
 * own commit output and PR links, since printed text often just mentions other work.
 */
function refsIn(text: string, into: Set<string>, raw: boolean): void {
  for (const m of text.matchAll(PR_URL)) into.add(`PR #${m[1]}`);
  if (!raw) for (const m of text.matchAll(PR_WORD)) into.add(`PR #${m[1]}`);
  for (const m of text.matchAll(raw ? COMMIT_LINE : COMMIT_QUOTED)) if (/\d/.test(m[1]) && /[a-f]/.test(m[1])) into.add(m[1].slice(0, 9));
}

/**
 * Messages the system sends in the person's place (a background task finishing, a hook's
 * feedback, another session's message, an interruption, a command's output): not asks.
 */
const SYSTEM_TURN = /^(<task-notification>|<agent-message|<local-command-|Stop hook feedback|Another Claude session sent a message|\[Request interrupted|Caveat: The messages below|<system-reminder>|\[(?:Crosstalk|Relay)\])/;

/** A slash command the person typed, as they typed it: "/pr-review 845". */
function slashCommand(text: string): string | undefined {
  const name = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
}

/** A slash command in a raw chat line (a damaged line is just not one). */
function commandIn(line: string): string | undefined {
  try {
    const content = JSON.parse(line)?.message?.content;
    return typeof content === "string" ? slashCommand(content) : undefined;
  } catch {
    return undefined;
  }
}

/** The person's words in a message, or nothing for a message the system sent. */
function personSaid(text: string): string | undefined {
  const t = text.trim();
  const command = slashCommand(t);
  if (command) return command;
  if (!t || SYSTEM_TURN.test(t)) return undefined;
  return t;
}

function timeOf(line: string): number | undefined {
  const m = /"timestamp":"([^"]+)"/.exec(line);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The exchanges in a stretch of lines starting at byte `offset` (Claude Code and Codex). Each line
 * is read on its own, so every file and ref lands on the ask it belongs to. A reply with no ask
 * before it (the end of an ask already recorded) comes back with an empty ask.
 */
function exchangesInLines(tool: RecordTool, lines: string[], offset: number, now: number): Exchange[] {
  const out: Exchange[] = [];
  let pos = offset;
  let cur: Exchange | undefined;
  for (const line of lines) {
    const start = pos;
    pos += Buffer.byteLength(line, "utf8") + 1;
    if (!line) continue;
    const { messages, files } = tool === "codex" ? codexMessages([line]) : claudeMessages([line]);
    // A slash command's tags are cleaned out of the message: it is read from the line itself.
    const command = line.includes("<command-name>") ? commandIn(line) : undefined;
    const youText = command ?? messages.find((m) => m.who === "you")?.text;
    const said = youText !== undefined ? personSaid(youText) : undefined;
    if (said) {
      cur = { ask: said, reply: "", last: "", files: new Set(), refs: new Set(), at: timeOf(line) ?? now, start, end: pos };
      out.push(cur);
      continue;
    }
    cur ??= (out.push({ ask: "", reply: "", last: "", files: new Set(), refs: new Set(), at: timeOf(line) ?? now, start, end: pos }), out[out.length - 1]);
    for (const m of messages)
      if (m.who === "ai") {
        cur.reply = cur.reply ? `${cur.reply}\n\n${m.text}` : m.text;
        cur.last = m.text;
      }
    for (const f of files) cur.files.add(f);
    // What commands printed (a commit line, a PR link) counts too; what the agent wrote into files doesn't.
    if (line.includes('"tool_result"') || line.includes('"function_call_output"')) refsIn(line, cur.refs, true);
    cur.end = pos;
  }
  return out;
}

function exchangesInMessages(list: ChatMessage[], files: string[], from: number, now: number): Exchange[] {
  const out: Exchange[] = [];
  let cur: Exchange | undefined;
  list.forEach((m, i) => {
    const said = m.who === "you" ? personSaid(m.text) : undefined;
    if (said) {
      cur = { ask: said, reply: "", last: "", files: new Set(), refs: new Set(), at: now, start: from + i, end: from + i + 1 };
      out.push(cur);
    } else if (m.who === "ai") {
      cur ??= (out.push({ ask: "", reply: "", last: "", files: new Set(), refs: new Set(), at: now, start: from + i, end: from + i + 1 }), out[out.length - 1]);
      cur.reply = cur.reply ? `${cur.reply}\n\n${m.text}` : m.text;
      cur.last = m.text;
      cur.end = from + i + 1;
    }
  });
  // Gemini's file names its edits per range; they go with the last ask read.
  if (out.length) for (const f of files) out[out.length - 1].files.add(f);
  return out;
}

/** Shortens a long ask, saying how much is left out (a pasted log should not fill the record). */
function clipAsk(text: string): string {
  const t = text.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= ASK_MAX) return t;
  return `${t.slice(0, ASK_MAX - 60).trimEnd()} … [+${(t.length - (ASK_MAX - 60)).toLocaleString("en-US")} characters]`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The reply's first real paragraph: Crosstalk's replies, and most agents', lead with the outcome. */
function firstParagraph(reply: string): string {
  for (const p of reply.split(/\n\s*\n/)) {
    const t = p.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^\|/.test(t) || /^```/.test(t)) continue;
    return clip(t, DID_MAX);
  }
  return clip(reply, DID_MAX);
}

/** A "Next:" line or a question the reply ended on: what is still open. */
function openItem(reply: string): string | undefined {
  const paras = reply.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1];
  if (!last || paras.length < 2) return undefined;
  if (/^(\*\*)?next\b/i.test(last) || /\?\s*$/.test(last)) return clip(last.replace(/^\*\*next:?\*\*:?\s*/i, "Next: "), OPEN_MAX);
  return undefined;
}

function toAsk(e: Exchange, n: number): RecordAsk {
  const refs = new Set<string>();
  refsIn(e.reply, refs, false);
  for (const r of e.refs) refs.add(r);
  const ask: RecordAsk = {
    n,
    at: e.at,
    ask: redact(clipAsk(e.ask)),
    did: redact(firstParagraph(e.last || e.reply)),
    files: [...e.files],
    refs: [...refs].slice(0, REFS_MAX),
    src: [e.start, e.end],
  };
  const open = openItem(e.last || e.reply);
  if (open && open !== ask.did) ask.open = redact(open);
  return ask;
}

/**
 * The asks in a chat's file from `cursor`, and where reading stopped. `maxBytes` reads a slice
 * of a big file (Claude Code and Codex). `lastReply` is the reply that just ended, which the hook
 * gets before the agent has written it to the file.
 */
export function readAsksFrom(
  tool: RecordTool,
  file: string,
  cursor: number,
  firstN: number,
  opts: { maxBytes?: number; lastReply?: string; now?: number; holdOpen?: boolean } = {},
): { asks: RecordAsk[]; next: number; trailing?: string } {
  const now = opts.now ?? Date.now();
  let ex: Exchange[];
  let next: number;
  if (tool === "gemini") {
    const all = loadGeminiChat(file)?.messages ?? [];
    const from = Math.min(cursor, all.length);
    const { messages, files } = geminiMessages(all.slice(from));
    ex = exchangesInMessages(messages, files, from, now);
    next = all.length;
  } else {
    // Read in slices, an ask is only recorded once its whole reply is in: the last ask of a slice
    // is read again with the next one, and a slice holding a single huge ask grows until it ends.
    const size = fileSize(file);
    let max = opts.maxBytes ?? Infinity;
    for (;;) {
      const r = readLinesFrom(file, cursor, max);
      ex = exchangesInLines(tool, r.lines, cursor, now);
      next = r.next;
      const atEnd = next >= size;
      if (atEnd && opts.holdOpen && ex.length && ex[ex.length - 1].ask) {
        // A chat still working: its newest ask waits until the file has gone quiet.
        next = ex.pop()!.start;
      }
      if (atEnd || !Number.isFinite(max)) break;
      if (ex.length >= 2) {
        next = ex.pop()!.start;
        break;
      }
      max = Math.min(max * 2, size);
    }
  }  // A reply with no ask before it ends an ask already recorded (written after the hook last ran):
  // the record keeps the outcome it had.
  const lead = ex[0] && !ex[0].ask ? ex.shift() : undefined;
  const trailing = lead ? lead.last || lead.reply : undefined;
  const last = ex[ex.length - 1];
  if (last && opts.lastReply && !last.reply.includes(opts.lastReply.trim().slice(0, 200))) {
    last.reply = last.reply ? `${last.reply}\n\n${opts.lastReply}` : opts.lastReply;
    last.last = opts.lastReply;
  }
  return { asks: ex.map((e, i) => toAsk(e, firstN + i)), next, trailing };
}

/**
 * Brings a chat's record up to date and returns the asks added. Without a record yet, one is
 * started for a chat small enough to read now; a bigger one is left to `catchUpRecord`.
 */
export function updateRecord(
  id: string,
  tool: RecordTool,
  file: string,
  opts: { cwd?: string; title?: string; maxBytes?: number; lastReply?: string; startMax?: number; now?: number; holdOpen?: boolean } = {},
): RecordAsk[] {
  if (!safeId(id) || !file) return [];
  const now = opts.now ?? Date.now();
  let head = readHead(id);
  if (!head) {
    if (tool !== "gemini" && fileSize(file) > (opts.startMax ?? HOOK_START_MAX)) return [];
    head = { id, tool, file, cursor: 0, n: 0, updatedAt: now, cwd: opts.cwd, title: opts.title };
  }
  if (tool !== "gemini" && head.cursor > fileSize(file)) {
    // The file was replaced: recorded again from the start.
    fs.rmSync(asksFile(id), { force: true });
    head = { ...head, cursor: 0, n: 0 };
  }
  const { asks, next } = readAsksFrom(tool, file, head.cursor, head.n + 1, { maxBytes: opts.maxBytes, lastReply: opts.lastReply, now, holdOpen: opts.holdOpen });
  if (asks.length) {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(asksFile(id), asks.map((a) => JSON.stringify(a)).join("\n") + "\n");
  }
  const goal = head.goal ?? (asks[0] ? clip(asks[0].ask, 240) : undefined);
  writeHead({ ...head, file, goal, cwd: opts.cwd ?? head.cwd, title: opts.title ?? head.title, cursor: next, n: head.n + asks.length, updatedAt: asks.length || next !== head.cursor ? now : head.updatedAt });
  return asks;
}

/** How much of a chat's file the record hasn't read yet. */
export function recordBehind(id: string, tool: RecordTool, file: string): number {
  if (tool === "gemini") return readHead(id) ? 0 : 1;
  const size = fileSize(file);
  const at = readHead(id)?.cursor ?? 0;
  return at > size ? size : size - at;
}

/** Reads a big chat's file into its record a slice at a time, letting everything else run between slices. */
export async function catchUpRecord(id: string, tool: RecordTool, file: string, opts: { cwd?: string; title?: string; slice?: number } = {}): Promise<void> {
  const slice = opts.slice ?? 8 * 1024 * 1024;
  for (let i = 0; i < 100_000 && recordBehind(id, tool, file) > 0; i++) {
    const before = readHead(id)?.cursor;
    // A file written to in the last 2 minutes belongs to a chat still working: its newest ask waits.
    const working = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 120_000;
    updateRecord(id, tool, file, { cwd: opts.cwd, title: opts.title, maxBytes: slice, startMax: Infinity, holdOpen: working });
    if (readHead(id)?.cursor === before) break; // nothing more can be read (a line still being written)
    await new Promise((r) => setImmediate(r));
  }
}

/** Exactly the bytes [start, end) of a file (at most 64 MB: one exchange's tool output can be large). */
function readRange(file: string, start: number, end: number): string {
  const len = Math.max(0, Math.min(end - start, 64 * 1024 * 1024));
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, got).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The exact words of one recorded ask, read again from the agent's own file. */
/** A chat file inside Claude Code's, Codex's or Gemini CLI's own folders (after following links):
 *  ~/.claude, ~/.codex (sessions and archived ones) or ~/.gemini, wherever each is configured. */
export function isAgentChatFile(file: string | undefined): boolean {
  if (!file) return false;
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  return [claudeProjectsDir(), codexSessionsDir(), geminiTmpDir()].map((d) => path.dirname(d)).some((d) => {
    let base = d;
    try {
      base = fs.realpathSync(d);
    } catch {
      // Not there: nothing can be inside it.
    }
    return real.startsWith(base + path.sep);
  });
}

export function exchangeText(id: string, n: number, max = 20_000): string | undefined {
  const head = readHead(id);
  const ask = readAsks(id).find((a) => a.n === n);
  // A flightlog restored from a shared backup folder names its chat file: read it only when that
  // really is an agent's chat file on this computer, never any other path.
  if (!head || !ask || !isAgentChatFile(head.file)) return undefined;
  const [start, end] = ask.src;
  let messages: ChatMessage[];
  if (head.tool === "gemini") {
    messages = geminiMessages((loadGeminiChat(head.file)?.messages ?? []).slice(start, end)).messages;
  } else {
    const lines = readRange(head.file, start, end).split("\n");
    messages = (head.tool === "codex" ? codexMessages(lines) : claudeMessages(lines)).messages;
  }
  const text = redact(messages.map((m) => `**${m.who === "you" ? "You" : toolName(head.tool)}:** ${m.text.trim()}`).join("\n\n"));
  return text.length > max ? `${text.slice(0, max)}\n\n… (${(text.length - max).toLocaleString("en-US")} more characters)` : text;
}

// ---- what a linked chat is sent ----

/** How much a link sends after each reply: a line per ask, a short summary, or the words themselves. */
export type LinkLevel = "ping" | "brief" | "full";
export const LINK_LEVELS: LinkLevel[] = ["ping", "brief", "full"];

/** Files named as the receiving chat can open them: short in the same folder, full paths elsewhere. */
function fileNames(files: string[], root: string | undefined, absolute: boolean, max: number): string {
  const names = files.map((f) => (absolute ? fullPath(f, root) : relativeTo(f, root)));
  return names.length > max ? `${names.slice(0, max).join(", ")} (+${names.length - max})` : names.join(", ");
}

/** The first sentence, for a one-line headline. */
function firstSentence(text: string, max: number): string {
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(text);
  return clip(m ? m[1] : text, max);
}

export function renderAsk(a: RecordAsk, level: Exclude<LinkLevel, "full">, opts: { root?: string; absolute?: boolean } = {}): string {
  const files = a.files.length ? fileNames(a.files, opts.root, !!opts.absolute, level === "ping" ? 3 : 8) : "";
  const refs = a.refs.length ? a.refs.join(", ") : "";
  if (level === "ping") {
    const extra = [files && `files: ${files}`, refs].filter(Boolean).join(" · ");
    return `• ${clip(a.ask, 160)} → ${firstSentence(a.did || "(no reply yet)", 220)}${extra ? ` (${extra})` : ""}`;
  }
  return [
    `**Asked:** ${a.ask.replace(/\n+/g, " ")}`,
    `**Done:** ${a.did || "(no reply yet)"}`,
    a.open && `**Open:** ${a.open}`,
    files && `Files: ${files}`,
    refs && `Refs: ${refs}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Several asks, as one piece: headlines one per line, summaries a paragraph each. */
export function renderAsks(asks: RecordAsk[], level: Exclude<LinkLevel, "full">, opts: { root?: string; absolute?: boolean } = {}): string {
  return asks.map((a) => renderAsk(a, level, opts)).join(level === "ping" ? "\n" : "\n\n");
}

/** Where the rest of a record can be read: the tool, and the file for agents without it. */
export function recordPointer(id: string, title: string): string {
  return `The rest of that chat's flightlog: the crosstalk_flightlog tool (chat "${title}"), or ${asksFile(id)} (one JSON line per ask). The exact words of an ask: crosstalk_flightlog with its n.`;
}

/**
 * What a chat gets on being linked: what the other chat set out to do, how many asks it has had,
 * and the latest few in full summary. `since`: only what is new after a time (a link made again).
 */
export function recordContext(id: string, title: string, opts: { root?: string; absolute?: boolean; latest?: number; since?: number } = {}): string | undefined {
  const head = readHead(id);
  if (!head) return undefined;
  const latest = opts.latest ?? 10;
  const all = readAsks(id, opts.since ? undefined : latest);
  const asks = opts.since ? all.filter((a) => a.at > opts.since!).slice(-latest) : all;
  const intro = opts.since
    ? asks.length
      ? `New since it last reached this chat (${head.n} asks in all):`
      : `Nothing new since it last reached this chat (${head.n} asks in all).`
    : `It set out to: ${head.goal ?? "(not recorded)"}\n${head.n} ask${head.n === 1 ? "" : "s"} so far${asks.length < head.n ? `; the latest ${asks.length}` : ""}:`;
  return [intro, asks.length ? renderAsks(asks, "brief", opts) : "", recordPointer(id, title)].filter(Boolean).join("\n\n");
}
