// Crosstalk's tools for any AI tool that speaks MCP (Claude Code, Codex, Cursor, Gemini CLI ...):
// the code map, the flightlogs of every chat on this computer, and notes. Three tools on purpose:
// every tool's definition is paid for in every chat, used or not, so they are few and short.
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listNotes, saveNote } from "../core/notes";
import { catchUpRecord, exchangeText, listHeads, readAsks, recordBehind, type RecordAsk, type RecordHead } from "../core/record";
import { workspaceCrosstalkPath } from "../core/paths";
import { CodeMap } from "../codemap/index";
import { renderTokenReport, tokenReport } from "../core/tokens";
import { allCommands, renderCommand, userLibraryDir, type LibraryCommand } from "../library/index";

const root = process.env.CROSSTALK_ROOT || process.cwd();

// Shown to the agent at the start of every session, so it reaches for Crosstalk without being told.
// Short on purpose (the agent reads it in every chat); the most useful line first.
const INSTRUCTIONS = [
  "Crosstalk gives this project a map of its code and the records of the person's other AI chats on this computer.",
  "- To find code (where something is defined, what calls or imports it, how a folder is laid out), call crosstalk_map before grep, glob or reading whole files: find for a name or plain words, outline for a file or folder, graph for who uses what, no arguments for an overview. It answers in a few hundred tokens.",
  "- When the person refers to earlier work or another chat (what was done, which chat changed something, what happened while they were away), call crosstalk_flightlog: with query to search every chat, or with chat to read one.",
  "- crosstalk_notes holds notes chats left for this project; read them before working in an unfamiliar area, and save one when you learn something the next chat should know.",
].join("\n");

const server = new McpServer({ name: "crosstalk", version: __CROSSTALK_VERSION__ }, { instructions: INSTRUCTIONS });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

// ---- the code map: where things are in this codebase, in a few hundred tokens, no AI ----

const codeMap = new CodeMap(root);
let lastSweep = 0;

/** The map, brought up to date first: only files whose size or time changed are read again. */
async function freshMap(): Promise<CodeMap> {
  if (Date.now() - lastSweep > 1500) {
    await codeMap.refresh();
    lastSweep = Date.now();
  }
  return codeMap;
}

/**
 * What the chat calling is working on: the files its newest asks touched. The calling chat is this
 * folder's most recently active one (an MCP server is started per chat, in the chat's folder).
 */
function recentFiles(): string[] {
  try {
    const head = listHeads().filter((h) => h.cwd === root).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!head) return [];
    return [...new Set(readAsks(head.id, 8).flatMap((a) => a.files))].slice(0, 20);
  } catch {
    return [];
  }
}

server.registerTool(
  "crosstalk_map",
  {
    description:
      "This codebase's map (no AI). find: words or a name → ranked code with path:start-end; cheaper than grep and reading files. outline: a path or name → its parts with lines. graph: who uses it, what it uses. check: unused code or stale docs. None: overview.",
    inputSchema: {
      find: z.string().optional(),
      outline: z.string().optional(),
      graph: z.string().optional(),
      hops: z.number().int().min(1).max(2).optional(),
      check: z.enum(["unused", "docs"]).optional(),
    },
  },
  async ({ find, outline, graph, hops, check }) => {
    const map = await freshMap();
    if (check === "unused") return text(map.unusedText());
    if (check === "docs") {
      const stale = map.staleDocs();
      return text(stale.length ? stale.map((d) => `${d.file}:${d.line}  names ${d.missing} (${d.kind}), which no longer exists`).join("\n") : "Every file, hook and script the docs name exists.");
    }
    if (find) return text(map.find(find, { focus: recentFiles() }));
    if (outline) return text(map.outline(outline));
    if (graph) return text(map.graphOf(graph, (hops ?? 1) as 1 | 2));
    return text(map.overview());
  },
);

// ---- flightlogs: what any chat on this computer was asked and did, a line per ask ----

const when = (at: number) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (t: string, max: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const nameOf = (h: RecordHead) => h.title ?? (h.goal ? short(h.goal, 60) : h.id.slice(0, 8));

/** The records a chat name, id or part of either points to; this folder's first. */
function findRecords(chat: string): RecordHead[] {
  const q = chat.trim().toLowerCase();
  const all = listHeads();
  const exact = all.filter((h) => h.id === q || h.id.startsWith(q) || (h.title ?? "").toLowerCase() === q);
  const hits = exact.length ? exact : all.filter((h) => (h.title ?? "").toLowerCase().includes(q) || (h.goal ?? "").toLowerCase().includes(q));
  return hits.sort((a, b) => Number(b.cwd === root) - Number(a.cwd === root));
}

function askLine(a: RecordAsk): string {
  const extra = [a.files.length ? `${a.files.length} file${a.files.length === 1 ? "" : "s"}` : "", ...a.refs].filter(Boolean).join(", ");
  return `#${a.n} · ${when(a.at)} · ${short(a.ask, 160)} → ${short(a.did || "(no reply)", 220)}${extra ? ` (${extra})` : ""}`;
}

server.registerTool(
  "crosstalk_flightlog",
  {
    description:
      "What AI chats on this computer were asked and did, a line per ask. No chat: lists them; with query, searches all (words or code names). n: one ask in full. tokens: where its tokens went.",
    inputSchema: {
      chat: z.string().optional(),
      query: z.string().optional(),
      last: z.number().int().min(1).max(500).optional(),
      n: z.number().int().min(1).optional(),
      tokens: z.boolean().optional(),
    },
  },
  async ({ chat, query, last, n, tokens }) => {
    if (tokens) {
      const h = chat ? findRecords(chat)[0] : listHeads().filter((x) => x.cwd === root).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!h?.file) return text("No chat file to read: name the chat.", true);
      return text(renderTokenReport(tokenReport(h.tool, h.file), nameOf(h)));
    }
    if (!chat && query) return text(await recall(query));
    if (!chat) {
      const heads = listHeads().slice(0, 25);
      return text(
        heads.length
          ? heads.map((h) => `${nameOf(h)} · ${h.cwd ? path.basename(h.cwd) : "?"} · ${h.n} asks · ${when(h.updatedAt)} · id ${h.id.slice(0, 8)}`).join("\n")
          : "No flightlogs yet. Crosstalk starts one for each chat as it replies.",
      );
    }
    const found = findRecords(chat);
    if (!found.length) return text(`No flightlog matches "${chat}". Call crosstalk_flightlog with no chat to see them.`, true);
    if (n) {
      const words = exchangeText(found[0].id, n);
      return words ? text(words) : text(`No ask #${n} in a flightlog matching "${chat}".`, true);
    }
    if (found.length > 1 && !found.some((h) => h.id === chat)) {
      const list = found.slice(0, 10).map((h) => `${nameOf(h)} · ${h.cwd ? path.basename(h.cwd) : "?"} · ${h.n} asks · id ${h.id.slice(0, 8)}`);
      if (found.length > 10) list.push(`… ${found.length - 10} more`);
      return text(`Several chats match; name one by id:\n${list.join("\n")}`);
    }
    const h = found[0];
    // A record behind its chat (a big chat, read in the background until now) is caught up first.
    if (recordBehind(h.id, h.tool, h.file) > 0) await catchUpRecord(h.id, h.tool, h.file);
    let asks = readAsks(h.id);
    if (query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      asks = asks.filter((a) => {
        const hay = `${a.ask} ${a.did} ${a.open ?? ""} ${a.files.join(" ")} ${a.refs.join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const count = last ?? 30;
    const shown = asks.slice(-count);
    const fresh = readAsks(h.id, 1)[0];
    const lines = [
      `${nameOf(h)} (${h.tool}, ${h.cwd ?? "folder unknown"}): ${h.n} asks, last ${when(h.updatedAt)}.`,
      h.goal ? `It set out to: ${short(h.goal, 240)}` : "",
      fresh?.open ? `Still open: ${fresh.open}` : "",
      query ? `${asks.length} ask${asks.length === 1 ? "" : "s"} mention "${query}"${asks.length > count ? `; the newest ${count}` : ""}:` : asks.length > count ? `The newest ${count} (ask with last for more):` : "",
      ...shown.map(askLine),
      "The exact words of an ask: crosstalk_flightlog with its n.",
    ].filter(Boolean);
    return text(lines.join("\n"));
  },
);

/**
 * Every chat's asks that match: by words, and by code. A code name the map knows ("useEditRights")
 * also finds the asks that changed the file it lives in.
 */
async function recall(query: string): Promise<string> {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  let files = new Set<string>();
  try {
    const map = await freshMap();
    const hits = map.findHits(query).filter((h) => h.score > 20).slice(0, 3);
    files = new Set(hits.map((h) => path.join(root, h.doc.file.p)));
  } catch {
    // No map here: words alone.
  }
  const found: { h: RecordHead; a: RecordAsk; score: number }[] = [];
  for (const h of listHeads()) {
    for (const a of readAsks(h.id)) {
      const hay = `${a.ask} ${a.did} ${a.open ?? ""} ${a.files.join(" ")} ${a.refs.join(" ")}`.toLowerCase();
      let score = words.filter((w) => hay.includes(w)).length / Math.max(1, words.length);
      if (a.files.some((f) => files.has(f))) score += 1;
      if (score >= 0.66) found.push({ h, a, score: score + (h.cwd === root ? 0.1 : 0) + a.at / 1e15 });
    }
  }
  if (!found.length) return `No chat's asks mention "${query}".`;
  found.sort((x, y) => y.score - x.score);
  return found
    .slice(0, 12)
    .map(({ h, a }) => `${nameOf(h)} (id ${h.id.slice(0, 8)}) ${askLine(a)}`)
    .join("\n");
}

// ---- notes: what one chat leaves in this project for others ----

server.registerTool(
  "crosstalk_notes",
  {
    description: "Notes chats leave for this project. None: list. name: read one. title and text: save one (to hand over work).",
    inputSchema: {
      name: z.string().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
    },
  },
  async ({ name, title, text: body }) => {
    if (title && body) {
      const saved = saveNote(root, title, `# ${title}\n\n${body.trim()}`);
      return text(`Saved as ${saved}. Other chats can read it with crosstalk_notes.`);
    }
    if (name) {
      const dir = workspaceCrosstalkPath(root);
      const file = path.resolve(dir, name);
      if (!file.startsWith(path.join(dir, "notes") + path.sep) || !fs.existsSync(file)) {
        return text(`No note called ${name}. Call crosstalk_notes with nothing to see the names.`, true);
      }
      return text(fs.readFileSync(file, "utf8"));
    }
    const notes = listNotes(root);
    return text(
      notes.length
        ? notes.map((x) => `${x.name} — ${x.title} (${new Date(x.at).toISOString().slice(0, 16).replace("T", " ")})`).join("\n")
        : "No notes yet in this project.",
    );
  },
);

// ---- the Library: Crosstalk's commands and the person's own, as slash commands ----

type Registered = ReturnType<typeof server.registerPrompt>;
const prompts = new Map<string, { reg: Registered; key: string }>();

function promptKey(c: LibraryCommand): string {
  return `${c.source}\0${c.description}\0${c.body}\0${c.args.map((a) => `${a.name}${a.required ? "*" : ""}`).join(",")}`;
}

/** Offers every command as an MCP prompt; run again, it adds, updates and removes what changed. */
function syncPrompts() {
  const commands = allCommands();
  const seen = new Set<string>();
  for (const c of commands) {
    seen.add(c.name);
    const key = promptKey(c);
    const had = prompts.get(c.name);
    if (had && had.key === key) continue;
    had?.reg.remove();
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const a of c.args) argsSchema[a.name] = a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description);
    const reg = server.registerPrompt(
      c.name,
      { title: c.title, description: c.needs ? `${c.description} (needs ${c.needs} connected)` : c.description, argsSchema },
      (values: Record<string, unknown>) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: renderCommand(c, values as Record<string, string | undefined>) } }],
      }),
    );
    prompts.set(c.name, { reg, key });
  }
  for (const [name, p] of prompts) {
    if (!seen.has(name)) {
      p.reg.remove();
      prompts.delete(name);
    }
  }
}

syncPrompts();
// The person's own commands are live: a saved file is offered within a few seconds.
let libraryStamp = "";
setInterval(() => {
  let stamp = "";
  try {
    const dir = userLibraryDir();
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".md")) continue;
      const st = fs.statSync(path.join(dir, f));
      stamp += `${f}:${st.mtimeMs}:${st.size};`;
    }
  } catch {
    // No library folder: only the shipped commands.
  }
  if (stamp !== libraryStamp) {
    const first = libraryStamp === "" && stamp === "";
    libraryStamp = stamp;
    if (!first) syncPrompts();
  }
}, 3000).unref();

server.connect(new StdioServerTransport()).catch((err) => {
  console.error("crosstalk-mcp:", err);
  process.exit(1);
});
