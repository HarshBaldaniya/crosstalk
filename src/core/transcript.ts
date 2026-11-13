// Reads Claude Code's chat files directly, from a byte offset onwards. Used for
// what the SDK does not give: new messages since last time (live updates) and
// token usage. Light on purpose: the hook imports it.
import * as fs from "node:fs";
import type { ChatMessage, Usage } from "./types";

const CHUNK = 4 * 1024 * 1024;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Reads whole lines from `offset` to the end. `next` stops before a line still being written. */
/**
 * The last whole lines of a file, from its final `bytes` only: enough for a chat's latest
 * model and context without reading a history that can run to a gigabyte.
 */
export function readTail(file: string, bytes = 512 * 1024): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line was cut in half
    if (lines.length && !lines[lines.length - 1].endsWith("}")) lines.pop(); // still being written
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The whole lines written after `offset`, and the offset after the last one (an unfinished last
 * line is left for next time). With `maxBytes`, stops after about that much, so a huge file can be
 * read a slice at a time. Lines are split on the newline byte before decoding, so a character cut
 * at a chunk's edge is never mangled.
 */
export function readLinesFrom(file: string, offset: number, maxBytes = Infinity): { lines: string[]; next: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { lines: [], next: offset };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset > size) offset = 0; // the file was replaced
    const lines: string[] = [];
    let pos = offset;
    let next = offset;
    let pending: Buffer[] = [];
    // A single line longer than the slice is still read whole.
    while (pos < size && (pos - offset < maxBytes || lines.length === 0)) {
      const len = Math.min(CHUNK, size - pos, Math.max(64 * 1024, maxBytes));
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const nl = buf.lastIndexOf(0x0a);
      if (nl === -1) {
        pending.push(buf);
        continue;
      }
      lines.push(...Buffer.concat([...pending, buf.subarray(0, nl)]).toString("utf8").split("\n"));
      pending = [buf.subarray(nl + 1)];
      next = pos - (len - nl - 1);
    }
    return { lines, next };
  } finally {
    fs.closeSync(fd);
  }
}

export function fileSize(file: string | undefined): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; notebook_path?: string };
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { id?: string; content?: unknown; usage?: Record<string, number> };
}

/** Your words and Claude's replies from raw lines, without tool traffic or editor machinery. */
export function claudeMessages(lines: string[]): { messages: ChatMessage[]; files: string[] } {
  const messages: ChatMessage[] = [];
  const files = new Set<string>();
  for (const line of lines) {
    const o = parse<ClaudeLine>(line);
    if (!o || (o.type !== "user" && o.type !== "assistant")) continue;
    if (o.isSidechain || o.isMeta || o.isCompactSummary) continue;
    const content = o.message?.content;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) texts.push(b.text);
      if (o.type === "assistant" && b.type === "tool_use" && b.name && FILE_TOOLS.has(b.name)) {
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p) files.add(p);
      }
    }
    const text = cleanText(texts.join("\n"));
    if (!text) continue;
    const who = o.type === "user" ? "you" : "ai";
    const prev = messages[messages.length - 1];
    if (prev && prev.who === who && who === "ai") prev.text = `${prev.text}\n\n${text}`;
    else messages.push({ id: o.uuid ?? String(messages.length), who, text });
  }
  return { messages, files: [...files] };
}

/**
 * Token usage per assistant message, keyed by message id: Claude writes one
 * line per content block, each repeating the message's usage, so the last line
 * of a message wins.
 */
export function claudeUsage(lines: string[], into: Map<string, { u: Usage; day: string }>): void {
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    const o = parse<ClaudeLine>(line);
    const u = o?.message?.usage;
    const id = o?.message?.id;
    if (o?.type !== "assistant" || !u || !id) continue;
    into.set(id, {
      u: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      day: (o.timestamp ?? "").slice(0, 10),
    });
  }
}

/**
 * The latest main-chat reply's model and how much context it held (everything
 * read in plus what it wrote, which the next turn reads back).
 */
export function claudeLatest(lines: string[], prev?: { model?: string; used?: number }): { model?: string; used?: number } {
  let last = prev ?? {};
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    const o = parse<ClaudeLine & { message?: { model?: string } }>(line);
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u || o.isSidechain) continue;
    const model = (o.message as { model?: string }).model;
    if (model === "<synthetic>") continue;
    last = {
      model: model ?? last.model,
      used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
    };
  }
  return last;
}

/** Drops the machinery the editor adds around a message, so only what was said remains. */
export function cleanText(text: string): string {
  let t = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, "")
    .replace(/<artifact-content-authored-by-others\/>/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
  if (/^\[Request interrupted/.test(t)) t = "";
  // A summary Claude wrote when the chat ran out of room is not something anyone said.
  if (/^(The summarized conversation|This session is being continued from a previous conversation)/.test(t)) t = "";
  // Crosstalk's own deliveries (also when Claude Code wraps them as hook feedback) are not part of the
  // conversation. They start with "[Crosstalk]"; a reply that only quotes Crosstalk's words is kept.
  if (/^(Stop hook feedback:\s*)?\[(Crosstalk|Relay)\]/.test(t) || /^Noted the updates from (linked|connected) chats\.?$/.test(t)) t = "";
  return t;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export function totalTokens(u: Usage | undefined): number {
  return u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
}

function parse<T>(line: string): T | undefined {
  if (!line) return undefined;
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}
