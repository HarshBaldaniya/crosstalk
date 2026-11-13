// Gemini CLI: each chat is a file under ~/.gemini/tmp/<project>/chats/.
//   - <project> is the folder's short name from ~/.gemini/projects.json (each such
//     folder also holds a .project_root naming its folder); before Gemini CLI 0.4x
//     it was the SHA-256 of the folder's path. Both are looked in.
//   - Current versions write session-<time>-<id>.jsonl: a first line with the
//     chat's details, then one line per message, with later lines that update a
//     message ({id} again, or $patch), rewind ($rewindTo) or set details ($set).
//     Older versions wrote one .json holding { sessionId, messages: [...] }.
// Messages are "user" or "gemini", with token counts on Gemini's replies.
// Anything not understood is skipped, never fatal.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ChatDigest, ChatMessage, ChatSession, ChatStats, Usage } from "../core/types";
import { NO_USAGE, contextWindow } from "../core/types";
import { geminiTmpDir } from "../core/paths";
import { addUsage, cleanText } from "../core/transcript";
import type { Adapter } from "./adapter";
import { today } from "./adapter";

const WRITE_TOOLS = /^(write_file|replace|edit|write_new_file)$/;
/** What Gemini CLI itself puts in a chat as if the person said it (its opening workspace summary). */
const NOISE = /^<(session_context|environment_context)>/;

export interface GeminiMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  tokens?: { input?: number; output?: number; cached?: number; thoughts?: number; tool?: number; total?: number };
  model?: string;
  toolCalls?: { name?: string; args?: { file_path?: string; absolute_path?: string } }[];
}

export interface GeminiChat {
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

export class GeminiAdapter implements Adapter {
  readonly tool = "Gemini" as const;
  private readonly cache = new Map<string, { mtime: number; chat: GeminiChat | null }>();

  present(): boolean {
    return fs.existsSync(geminiTmpDir());
  }

  async list(root: string | undefined, limit: number): Promise<ChatSession[]> {
    const files: { file: string; mtime: number; cwd?: string }[] = [];
    const dirs = root ? geminiChatDirs(root).map((dir) => ({ dir, cwd: root })) : geminiAllChatDirs();
    for (const { dir, cwd } of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(dir, n);
        try {
          files.push({ file, mtime: fs.statSync(file).mtimeMs, cwd });
        } catch {
          // Gone since the listing.
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const out: ChatSession[] = [];
    const seen = new Set<string>();
    for (const { file, mtime, cwd } of files) {
      if (out.length >= limit) break;
      const chat = this.load(file, mtime);
      // A chat moved from .json to .jsonl keeps its id: list the newer file only.
      if (!chat?.sessionId || seen.has(chat.sessionId)) continue;
      seen.add(chat.sessionId);
      const first = geminiMessages(chat.messages ?? []).messages.find((m) => m.who === "you");
      const title = first ? oneLine(first.text).slice(0, 90) || "Gemini chat" : "Gemini chat";
      out.push({ id: chat.sessionId, tool: "Gemini", title, cwd, createdAt: Date.parse(chat.startTime ?? "") || undefined, lastModified: mtime, status: "idle", file });
    }
    return out;
  }

  async read(chat: ChatSession): Promise<ChatDigest> {
    const c = this.loadChat(chat);
    const { messages, files } = geminiMessages(c?.messages ?? []);
    return { messages, filesChanged: files };
  }

  latest(chat: ChatSession): Pick<ChatStats, "model" | "context"> | undefined {
    // Gemini's chat files are small: the full read is cheap and cached.
    const u = this.usage(chat);
    return u && { model: u.model, context: u.context };
  }

  usage(chat: ChatSession): ChatStats | undefined {
    const c = this.loadChat(chat);
    if (!c) return undefined;
    return geminiUsage(c.messages ?? [], today());
  }

  end(chat: ChatSession): number {
    return this.loadChat(chat)?.messages?.length ?? 0;
  }

  since(chat: ChatSession, cursor: number) {
    const all = this.loadChat(chat)?.messages ?? [];
    return { ...geminiMessages(all.slice(cursor)), next: all.length };
  }

  resumeCommand(chat: ChatSession): string {
    return `gemini --resume ${chat.id}`;
  }

  newCommand(): string {
    return "gemini";
  }

  private loadChat(chat: ChatSession): GeminiChat | null {
    if (!chat.file) return null;
    try {
      return this.load(chat.file, fs.statSync(chat.file).mtimeMs);
    } catch {
      return null;
    }
  }

  private load(file: string, mtime: number): GeminiChat | null {
    const hit = this.cache.get(file);
    if (hit && hit.mtime === mtime) return hit.chat;
    const chat = loadGeminiChat(file);
    this.cache.set(file, { mtime, chat });
    return chat;
  }
}

/** The folders Gemini CLI keeps this project's chats in (current short name first, then the old hash). */
export function geminiChatDirs(root: string): string[] {
  const tmp = geminiTmpDir();
  // Gemini CLI keeps the folder's real path (/private/tmp, not /tmp): compare both ways.
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const wants = new Set([path.resolve(root), real(root)]);
  const same = (p: string) => wants.has(path.resolve(p)) || wants.has(real(p));
  const names = new Set<string>();
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(tmp), "projects.json"), "utf8")) as { projects?: Record<string, string> };
    for (const [folder, name] of Object.entries(registry.projects ?? {})) if (name && same(folder)) names.add(name);
  } catch {
    // No registry: an older Gemini CLI, or none.
  }
  if (!names.size) {
    // The registry can be missing or behind; each project folder also names its owner.
    try {
      for (const d of fs.readdirSync(tmp)) {
        try {
          if (same(fs.readFileSync(path.join(tmp, d, ".project_root"), "utf8").trim())) names.add(d);
        } catch {
          // Not a project folder.
        }
      }
    } catch {
      // No tmp folder yet.
    }
  }
  for (const w of wants) names.add(createHash("sha256").update(w).digest("hex"));
  return [...names].map((n) => path.join(tmp, n, "chats"));
}

/** Every project folder Gemini CLI has chats for, with the folder it belongs to. */
export function geminiAllChatDirs(): { dir: string; cwd: string }[] {
  const tmp = geminiTmpDir();
  const byName = new Map<string, string>();
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(tmp), "projects.json"), "utf8")) as { projects?: Record<string, string> };
    for (const [folder, name] of Object.entries(registry.projects ?? {})) if (name) byName.set(name, folder);
  } catch {
    // No registry: the folders' own markers are used.
  }
  const out: { dir: string; cwd: string }[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return out;
  }
  for (const name of names) {
    let cwd = byName.get(name);
    if (!cwd) {
      try {
        cwd = fs.readFileSync(path.join(tmp, name, ".project_root"), "utf8").trim();
      } catch {
        continue; // an old hash folder: its folder can't be told, so it is left to that folder's own view
      }
    }
    if (cwd && fs.existsSync(path.join(tmp, name, "chats"))) out.push({ dir: path.join(tmp, name, "chats"), cwd });
  }
  return out;
}

/** One Gemini chat file, either format, as its details and its messages in order. */
export function loadGeminiChat(file: string): GeminiChat | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (file.endsWith(".json")) {
    try {
      return JSON.parse(text) as GeminiChat;
    } catch {
      return null;
    }
  }
  let chat: GeminiChat | null = null;
  const byId = new Map<string, GeminiMessage>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (!r || typeof r !== "object") continue;
    if (typeof r.$rewindTo === "string") {
      let found = false;
      for (const id of [...byId.keys()]) {
        if (id === r.$rewindTo) found = true;
        if (found) byId.delete(id);
      }
      if (!found) byId.clear();
    } else if (r.$patch && typeof r.$patch === "object") {
      const patches = [r.$patch, ...(Array.isArray(r.$patch.updates) ? r.$patch.updates : [])];
      for (const p of patches) {
        const m = typeof p?.id === "string" ? byId.get(p.id) : undefined;
        if (m && p.content !== undefined) m.content = p.content;
      }
      for (const id of Array.isArray(r.$patch.removeIds) ? r.$patch.removeIds : []) byId.delete(id);
      if (Array.isArray(r.$patch.orderIds)) {
        const ordered = r.$patch.orderIds.filter((id: unknown) => typeof id === "string" && byId.has(id)) as string[];
        const set = new Set(ordered);
        const rest = [...byId.entries()].filter(([id]) => !set.has(id));
        const moved = ordered.map((id) => [id, byId.get(id)!] as const);
        byId.clear();
        for (const [id, m] of [...rest, ...moved]) byId.set(id, m);
      }
    } else if (r.$set && typeof r.$set === "object") {
      if (chat) Object.assign(chat, { ...r.$set, messages: undefined });
      if (Array.isArray(r.$set.messages)) {
        byId.clear();
        for (const m of r.$set.messages) if (typeof m?.id === "string") byId.set(m.id, m);
      }
    } else if (typeof r.id === "string" && typeof r.type === "string") {
      // The same message again (tokens or tool results added): the newer copy wins, in its first place.
      const had = byId.get(r.id);
      if (had) Object.assign(had, r);
      else byId.set(r.id, r);
    } else if (typeof r.sessionId === "string" && !chat) {
      chat = { sessionId: r.sessionId, startTime: r.startTime, lastUpdated: r.lastUpdated };
    }
  }
  if (!chat) return null;
  chat.messages = [...byId.values()];
  return chat;
}

export function geminiMessages(list: GeminiMessage[]): { messages: ChatMessage[]; files: string[] } {
  const messages: ChatMessage[] = [];
  const files = new Set<string>();
  list.forEach((m, i) => {
    for (const call of m.toolCalls ?? []) {
      const p = call.args?.file_path ?? call.args?.absolute_path;
      if (call.name && WRITE_TOOLS.test(call.name) && p) files.add(p);
    }
    if (m.type !== "user" && m.type !== "gemini") return;
    const text = cleanText(textOf(m.content));
    if (!text || (m.type === "user" && NOISE.test(text))) return;
    const who = m.type === "user" ? "you" : "ai";
    const prev = messages[messages.length - 1];
    if (prev && prev.who === who && who === "ai") prev.text = `${prev.text}\n\n${text}`;
    else messages.push({ id: m.id ?? `gemini-${i}`, who, text });
  });
  return { messages, files: [...files] };
}

export function geminiUsage(list: GeminiMessage[], day: string): ChatStats {
  let total = NO_USAGE;
  let todays = NO_USAGE;
  let model: string | undefined;
  let used: number | undefined;
  for (const m of list) {
    const t = m.tokens;
    if (!t) continue;
    if (m.model) model = m.model;
    used = (t.input ?? 0) + (t.output ?? 0) + (t.thoughts ?? 0);
    const cached = t.cached ?? 0;
    const u: Usage = { input: Math.max(0, (t.input ?? 0) - cached), output: (t.output ?? 0) + (t.thoughts ?? 0), cacheRead: cached, cacheWrite: 0 };
    total = addUsage(total, u);
    if ((m.timestamp ?? "").slice(0, 10) === day) todays = addUsage(todays, u);
  }
  return { total, today: todays, model, context: used ? { used, window: contextWindow(model) } : undefined };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("\n");
  return "";
}

function oneLine(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}
