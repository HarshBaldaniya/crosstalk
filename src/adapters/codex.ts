// Codex CLI: chats are "rollout" files under ~/.codex/sessions/YYYY/MM/DD/,
// one JSON line per event: session_meta (id, cwd), response_item (messages,
// tool calls) and event_msg (token counts). Older files had bare items with no
// wrapper; both are read. Anything not understood is skipped, never fatal.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatDigest, ChatMessage, ChatSession, ChatStats, Usage } from "../core/types";
import { NO_USAGE, contextWindow } from "../core/types";
import { codexSessionsDir } from "../core/paths";
import { cleanText, fileSize, readLinesFrom, readTail } from "../core/transcript";
import type { Adapter } from "./adapter";
import { today } from "./adapter";

const SCAN_FILES = 400;
const NOISE = /^(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md|<user_shell_command>)/;

interface Meta {
  id: string;
  cwd?: string;
  title: string;
  createdAt?: number;
  branch?: string;
}

interface Line {
  type?: string;
  timestamp?: string;
  payload?: Record<string, any>;
  [k: string]: any;
}

export class CodexAdapter implements Adapter {
  readonly tool = "Codex" as const;
  private readonly metaCache = new Map<string, { mtime: number; meta: Meta | null }>();
  private readonly usageCache = new Map<string, ChatStats & { size: number }>();
  private readonly latestCache = new Map<string, { size: number; stats: Pick<ChatStats, "model" | "context"> }>();

  present(): boolean {
    return fs.existsSync(codexSessionsDir());
  }

  async list(root: string | undefined, limit: number): Promise<ChatSession[]> {
    const out: ChatSession[] = [];
    for (const { file, mtime } of recentRollouts(codexSessionsDir(), SCAN_FILES)) {
      const meta = this.meta(file, mtime);
      if (!meta || !meta.cwd || (root && !sameFolder(meta.cwd, root))) continue;
      out.push({ id: meta.id, tool: "Codex", title: meta.title, cwd: meta.cwd, branch: meta.branch, createdAt: meta.createdAt, lastModified: mtime, status: "idle", file });
      if (out.length >= limit) break;
    }
    return out;
  }

  async read(chat: ChatSession): Promise<ChatDigest> {
    if (!chat.file) return { messages: [], filesChanged: [] };
    const { lines } = readLinesFrom(chat.file, 0);
    const { messages, files } = codexMessages(lines);
    return { messages, filesChanged: files };
  }

  usage(chat: ChatSession): ChatStats | undefined {
    if (!chat.file) return undefined;
    const size = fileSize(chat.file);
    const cached = this.usageCache.get(chat.file);
    if (cached && cached.size === size) return cached;
    const { lines } = readLinesFrom(chat.file, 0);
    const result = { size, ...codexUsage(lines, today()) };
    this.usageCache.set(chat.file, result);
    return result;
  }

  /** All of a changed rollout is counted again, so all of it is pending. */
  pendingBytes(chat: ChatSession): number {
    if (!chat.file) return 0;
    const size = fileSize(chat.file);
    return this.usageCache.get(chat.file)?.size === size ? 0 : size;
  }

  latest(chat: ChatSession): Pick<ChatStats, "model" | "context"> | undefined {
    if (!chat.file) return undefined;
    const size = fileSize(chat.file);
    const hit = this.latestCache.get(chat.file);
    if (hit && hit.size === size) return hit.stats;
    const { model, context } = codexUsage(readTail(chat.file), today());
    const stats = { model, context };
    this.latestCache.set(chat.file, { size, stats });
    return stats;
  }

  end(chat: ChatSession): number {
    return fileSize(chat.file);
  }

  since(chat: ChatSession, cursor: number) {
    if (!chat.file) return { messages: [], files: [], next: cursor };
    const { lines, next } = readLinesFrom(chat.file, cursor);
    return { ...codexMessages(lines), next };
  }

  resumeCommand(chat: ChatSession): string {
    return `codex resume ${chat.id}`;
  }

  newCommand(): string {
    return "codex";
  }

  private meta(file: string, mtime: number): Meta | null {
    const hit = this.metaCache.get(file);
    if (hit && hit.mtime === mtime) return hit.meta;
    const meta = readMeta(file);
    this.metaCache.set(file, { mtime, meta });
    return meta;
  }
}

/** The newest rollout files, walking the dated folders from the latest day back. */
export function recentRollouts(dir: string, max: number): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= max) return;
    let names: string[];
    try {
      names = fs.readdirSync(d).sort().reverse();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= max) return;
      const full = path.join(d, n);
      if (depth < 3 && /^\d+$/.test(n)) walk(full, depth + 1);
      else if (n.startsWith("rollout-") && n.endsWith(".jsonl")) {
        try {
          out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // Gone meanwhile.
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readMeta(file: string): Meta | null {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = head.split("\n");
  let id: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let branch: string | undefined;
  for (const raw of lines) {
    const o = parse(raw);
    if (!o) continue;
    const p = o.type === "session_meta" ? o.payload : !o.type && o.id && o.timestamp ? o : undefined;
    if (p && !id) {
      id = p.id;
      cwd = p.cwd ?? cwd;
      createdAt = Date.parse(p.timestamp ?? o.timestamp ?? "") || undefined;
      branch = p.git?.branch;
    }
    if (!cwd) {
      const text = JSON.stringify(o);
      const m = /<cwd>([^<]+)<\/cwd>/.exec(text);
      if (m) cwd = m[1].replace(/\\\\/g, "\\");
    }
  }
  if (!id) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file);
    id = m?.[1];
  }
  if (!id) return null;
  const first = codexMessages(lines).messages.find((m) => m.who === "you");
  const title = first ? oneLine(first.text).slice(0, 90) : "Codex chat";
  return { id, cwd, title, createdAt, branch };
}

/** Your words, Codex's replies and the files its patches touched. */
export function codexMessages(lines: string[]): { messages: ChatMessage[]; files: string[] } {
  const messages: ChatMessage[] = [];
  const files = new Set<string>();
  let n = 0;
  for (const raw of lines) {
    const o = parse(raw);
    if (!o) continue;
    const item = o.type === "response_item" ? o.payload : o.type === "message" || o.type === "function_call" || o.type === "custom_tool_call" ? o : undefined;
    if (!item) continue;
    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const parts: any[] = Array.isArray(item.content) ? item.content : [];
      const said = parts.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
      if (item.role === "user" && NOISE.test(said.trim())) continue;
      // cleanText also drops Crosstalk's own deliveries, which Codex records like messages.
      const text = cleanText(said);
      if (!text) continue;
      const who = item.role === "user" ? "you" : "ai";
      const prev = messages[messages.length - 1];
      if (prev && prev.who === who && who === "ai") prev.text = `${prev.text}\n\n${text}`;
      else messages.push({ id: `codex-${n++}`, who, text });
    } else if ((item.type === "function_call" || item.type === "custom_tool_call") && /patch/.test(String(item.name ?? ""))) {
      const body = String(item.arguments ?? item.input ?? "");
      for (const m of body.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)/g)) files.add(m[1].trim());
    }
  }
  return { messages, files: [...files] };
}

/** Codex reports running totals; the last one is the chat's, today's is the growth since yesterday's last. */
export function codexUsage(lines: string[], day: string): ChatStats {
  let last: any;
  let lastBeforeToday: any;
  let model: string | undefined;
  let used: number | undefined;
  let window: number | undefined;
  for (const raw of lines) {
    if (raw.includes("turn_context")) {
      const t = parse(raw);
      if (t?.type === "turn_context" && t.payload?.model) model = t.payload.model;
    }
    if (!raw.includes("token_count")) continue;
    const o = parse(raw);
    const info = o?.type === "event_msg" && o.payload?.type === "token_count" ? o.payload.info : undefined;
    if (info?.last_token_usage) used = (info.last_token_usage.input_tokens ?? 0) + (info.last_token_usage.output_tokens ?? 0);
    if (info?.model_context_window) window = info.model_context_window;
    const t = o?.type === "event_msg" && o.payload?.type === "token_count" ? o.payload.info?.total_token_usage : undefined;
    if (!t) continue;
    if ((o!.timestamp ?? "").slice(0, 10) < day) lastBeforeToday = t;
    last = t;
  }
  const toUsage = (t: any): Usage =>
    t
      ? {
          input: Math.max(0, (t.input_tokens ?? 0) - (t.cached_input_tokens ?? 0)),
          output: (t.output_tokens ?? 0) + (t.reasoning_output_tokens ?? 0),
          cacheRead: t.cached_input_tokens ?? 0,
          cacheWrite: 0,
        }
      : NO_USAGE;
  const total = toUsage(last);
  const before = toUsage(lastBeforeToday);
  return {
    total,
    today: { input: total.input - before.input, output: total.output - before.output, cacheRead: total.cacheRead - before.cacheRead, cacheWrite: 0 },
    model,
    context: used ? { used, window: window ?? contextWindow(model) } : undefined,
  };
}

function sameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function parse(line: string): Line | undefined {
  if (!line || line[0] !== "{") return undefined;
  try {
    return JSON.parse(line) as Line;
  } catch {
    return undefined;
  }
}

function oneLine(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}
