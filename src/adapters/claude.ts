// Claude Code: chats are listed and read with the Agent SDK's documented
// session functions (no sign-in, no Claude process); usage and "what's new"
// come straight from the chat file, read incrementally.
import * as fs from "node:fs";
import { getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChatDigest, ChatSession, ChatStats, Usage } from "../core/types";
import { NO_USAGE, contextWindow } from "../core/types";
import { claudeProjectsDir, findClaudeTranscript, readJson, crosstalkFile, writeFileAtomic } from "../core/paths";
import { addUsage, claudeLatest, claudeMessages, claudeUsage, cleanText, fileSize, readLinesFrom, readTail } from "../core/transcript";
import type { Adapter } from "./adapter";
import { today } from "./adapter";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface UsageCacheEntry {
  offset: number;
  /** The latest replies by message id (a reply is written several times as it streams). */
  byId: Map<string, { u: Usage; day: string }>;
  /** Earlier replies, already added up per day, so the cache stays small however long the chat. */
  base: Record<string, Usage>;
  latest: { model?: string; used?: number };
}

/** Saved between windows: a chat file is read once, ever, then only what is added to it. */
interface SavedUsage {
  v: 1;
  files: Record<string, { offset: number; base: Record<string, Usage>; tail: [string, { u: Usage; day: string }][]; latest: { model?: string; used?: number } }>;
}
/** Replies kept by id (the rest are folded into per-day sums): far more than a reply is ever repeated. */
const KEEP_BY_ID = 200;
const usageFile = () => crosstalkFile("usage-claude.json");

export class ClaudeAdapter implements Adapter {
  readonly tool = "Claude" as const;
  private readonly usageCache = this.loadSaved();
  private dirty = false;
  private readonly latestCache = new Map<string, { size: number; stats: Pick<ChatStats, "model" | "context"> }>();

  present(): boolean {
    return fs.existsSync(claudeProjectsDir());
  }

  async list(root: string | undefined, limit: number): Promise<ChatSession[]> {
    // With no folder, Claude Code lists the newest chats of every project.
    const infos = await listSessions(root ? { dir: root, limit } : { limit });
    return infos.map((s) => ({
      id: s.sessionId,
      tool: "Claude" as const,
      title: cleanTitle(s.customTitle || s.summary || s.firstPrompt || "Untitled chat"),
      cwd: s.cwd,
      branch: s.gitBranch,
      createdAt: s.createdAt,
      lastModified: s.lastModified,
      firstPrompt: s.firstPrompt,
      status: "idle" as const,
      file: findClaudeTranscript(s.sessionId, s.cwd ?? root),
    }));
  }

  async read(chat: ChatSession, root: string): Promise<ChatDigest> {
    const raw = await getSessionMessages(chat.id, { dir: chat.cwd ?? root });
    return digest(raw as RawMessage[]);
  }

  usage(chat: ChatSession): ChatStats | undefined {
    if (!chat.file) return undefined;
    const entry = this.entry(chat.file);
    if (fileSize(chat.file) !== entry.offset) this.step(chat.file, entry, Infinity);
    let total = NO_USAGE;
    let day = NO_USAGE;
    const d = today();
    for (const [when, u] of Object.entries(entry.base)) {
      total = addUsage(total, u);
      if (when === d) day = addUsage(day, u);
    }
    for (const { u, day: when } of entry.byId.values()) {
      total = addUsage(total, u);
      if (when === d) day = addUsage(day, u);
    }
    const { model, used } = entry.latest;
    return { total, today: day, model, context: used ? { used, window: contextWindow(model) } : undefined };
  }

  /** How much of the chat's file hasn't been read for its usage yet. */
  pendingBytes(chat: ChatSession): number {
    if (!chat.file) return 0;
    const size = fileSize(chat.file);
    const offset = this.usageCache.get(chat.file)?.offset ?? 0;
    return offset > size ? size : size - offset;
  }

  /** Reads one more slice of the chat's file for its usage (a huge file is read over many steps). */
  usageStep(chat: ChatSession, maxBytes: number): void {
    if (chat.file) this.step(chat.file, this.entry(chat.file), maxBytes);
  }

  private entry(file: string): UsageCacheEntry {
    let entry = this.usageCache.get(file);
    if (!entry) {
      entry = { offset: 0, byId: new Map(), base: {}, latest: {} };
      this.usageCache.set(file, entry);
    }
    return entry;
  }

  private step(file: string, entry: UsageCacheEntry, maxBytes: number): void {
    if (entry.offset > fileSize(file)) {
      // The file was replaced: counted again from the start.
      entry.offset = 0;
      entry.byId.clear();
      entry.base = {};
      entry.latest = {};
    }
    const { lines, next } = readLinesFrom(file, entry.offset, maxBytes);
    claudeUsage(lines, entry.byId);
    entry.latest = claudeLatest(lines, entry.latest);
    entry.offset = next;
    // Older replies are folded into their day's sum.
    while (entry.byId.size > KEEP_BY_ID) {
      const [id, { u, day }] = entry.byId.entries().next().value!;
      entry.byId.delete(id);
      entry.base[day] = addUsage(entry.base[day] ?? NO_USAGE, u);
    }
    this.dirty = true;
  }

  private loadSaved(): Map<string, UsageCacheEntry> {
    const saved = readJson<SavedUsage | undefined>(usageFile(), undefined);
    const out = new Map<string, UsageCacheEntry>();
    if (saved?.v !== 1) return out;
    for (const [file, e] of Object.entries(saved.files)) out.set(file, { offset: e.offset, base: e.base, byId: new Map(e.tail), latest: e.latest });
    return out;
  }

  /** Writes what has been counted, for the next window (files that are gone are left out). */
  saveCache(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const files: SavedUsage["files"] = {};
    for (const [file, e] of this.usageCache) {
      if (e.offset > 0 && fs.existsSync(file)) files[file] = { offset: e.offset, base: e.base, tail: [...e.byId], latest: e.latest };
    }
    try {
      writeFileAtomic(usageFile(), JSON.stringify({ v: 1, files } satisfies SavedUsage));
    } catch {
      // Only a cache: counted again next time.
    }
  }

  latest(chat: ChatSession): Pick<ChatStats, "model" | "context"> | undefined {
    if (!chat.file) return undefined;
    const size = fileSize(chat.file);
    const hit = this.latestCache.get(chat.file);
    if (hit && hit.size === size) return hit.stats;
    const { model, used } = claudeLatest(readTail(chat.file));
    const stats = { model, context: used ? { used, window: contextWindow(model) } : undefined };
    this.latestCache.set(chat.file, { size, stats });
    return stats;
  }

  end(chat: ChatSession): number {
    return fileSize(chat.file);
  }

  since(chat: ChatSession, cursor: number) {
    if (!chat.file) return { messages: [], files: [], next: cursor };
    const { lines, next } = readLinesFrom(chat.file, cursor);
    return { ...claudeMessages(lines), next };
  }

  resumeCommand(chat: ChatSession): string {
    return `claude --resume ${chat.id}`;
  }

  newCommand(): string {
    return "claude";
  }
}

interface RawMessage {
  type: string;
  uuid: string;
  parent_tool_use_id: string | null;
  message: unknown;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: string; notebook_path?: string };
}

/** The conversation as a person sees it, from the SDK's messages (which follow rewinds and branches). */
export function digest(raw: RawMessage[]): ChatDigest {
  const messages: ChatDigest["messages"] = [];
  const files = new Set<string>();
  for (const m of raw) {
    if (m.parent_tool_use_id) continue;
    if (m.type !== "user" && m.type !== "assistant") continue;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) texts.push(b.text);
      if (m.type === "assistant" && b.type === "tool_use" && b.name && FILE_TOOLS.has(b.name)) {
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p) files.add(p);
      }
    }
    const text = cleanText(texts.join("\n"));
    if (!text) continue;
    const who = m.type === "user" ? "you" : "ai";
    const prev = messages[messages.length - 1];
    if (prev && prev.who === who && who === "ai") prev.text = `${prev.text}\n\n${text}`;
    else messages.push({ id: m.uuid, who, text });
  }
  return { messages, filesChanged: [...files] };
}

function cleanTitle(title: string): string {
  const t = cleanText(title).replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 87)}…` : t || "Untitled chat";
}
