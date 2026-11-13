// Shapes shared by the extension, the webviews, the hook and the MCP server.

export type Tool = "Claude" | "Codex" | "Gemini";
export const TOOLS: Tool[] = ["Claude", "Codex", "Gemini"];

/** working: replying · waiting: needs you · done: replied, your turn · idle: quiet for a while */
export type Status = "working" | "waiting" | "done" | "idle";

/** Tokens, split the way every provider bills them. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface ChatRef {
  id: string;
  tool: Tool;
  title: string;
  /** The folder the chat works in, so a chat linked from another folder knows where its files are. */
  cwd?: string;
}

export interface ChatSession extends ChatRef {
  cwd?: string;
  branch?: string;
  createdAt?: number;
  lastModified: number;
  firstPrompt?: string;
  status: Status;
  /** What it is waiting for, when it is waiting. */
  lastLine?: string;
  /** The file that holds its history. */
  file?: string;
  usage?: Usage;
  usageToday?: Usage;
  /** The model of its latest reply, as the tool names it (e.g. "claude-opus-5-5"). */
  model?: string;
  /** How full its context window is after the latest reply. */
  context?: ContextUse;
  /** The chat belongs to another folder than the one open in the editor. */
  away?: boolean;
}

export interface ContextUse {
  used: number;
  window: number;
}

/** What a tool's records say about a chat's tokens, model and context. */
export interface ChatStats {
  total: Usage;
  today: Usage;
  model?: string;
  context?: ContextUse;
}

/** Context windows by model family; current Claude models have 1M. */
export function contextWindow(model: string | undefined): number {
  const m = (model ?? "").toLowerCase();
  if (/claude-(3|instant)|claude-(opus|sonnet|haiku)-4-[015]\b|haiku-4-5/.test(m)) return 200_000;
  if (/gpt-4o|o3|o4-mini/.test(m)) return 200_000;
  return 1_000_000;
}

export interface ChatMessage {
  id: string;
  who: "you" | "ai";
  text: string;
}

/** What a chat's history says, ready to turn into context. */
export interface ChatDigest {
  messages: ChatMessage[];
  filesChanged: string[];
}

/**
 * A live connection: everything `from` does reaches `to`. On connecting, `to`
 * gets `from`'s context; after that, an update each time `from` finishes a reply.
 */
export interface Connection {
  id: string;
  from: ChatRef;
  to: ChatRef;
  createdAt: number;
  paused?: boolean;
  /** How much it sends after each reply: a line per ask (the default), a summary, or the words. */
  level?: "ping" | "brief" | "full";
}

/** Context waiting to reach a chat with its next message. */
export interface InboxItem {
  connectionId?: string;
  from: ChatRef;
  at: number;
  /** context: on linking · update: after a reply · notice: a link changed (linked, unlinked, paused, resumed) */
  kind: "context" | "update" | "notice";
  /** For notices: only the latest notice on a topic is delivered (e.g. flipping a link back and forth). */
  topic?: string;
  text: string;
}

/** One piece of context that reached a chat. */
export interface Delivery {
  at: number;
  connectionId?: string;
  from: string;
  to: string;
  chars: number;
}

/** A new chat Crosstalk opened for a task; the hook recognises it by its first message. */
export interface PendingBranch {
  id: string;
  from: ChatRef;
  title: string;
  cwd?: string;
  at: number;
  taskStart: string;
  context: string;
  keepConnected: boolean;
}

export interface BoardPosition {
  x: number;
  y: number;
}

/** The workspace's board: which chats are on it and where. */
export interface BoardState {
  members: string[];
  positions: Record<string, BoardPosition>;
  /** The sides a link was drawn between, by "from>to": where the person dropped it. */
  handles?: Record<string, { s: string; t: string }>;
  /** How the board is laid out, kept with the workspace (and set by the sidebar's folder view). */
  arrange?: BoardArrange;
  /** The board was filled for the person once: an empty board after that is one they cleared. */
  seeded?: boolean;
  /** Where the person left the view (pan and zoom), so a board laid out by hand opens as it was. */
  viewport?: { x: number; y: number; zoom: number };
}

export type BoardArrange = "links" | "time" | "agent" | "folder" | "free";

/** What the hook writes to ~/.crosstalk/status/<sessionId>.json. */
export interface HookStatus {
  status: Status;
  at: number;
  event: string;
  cwd?: string;
  message?: string;
}

/** One plan limit as the agent reports it: how much of it is used, and when it starts over. */
export interface PlanWindow {
  label: string;
  /** 0-100, or null when the agent didn't say. */
  pct: number | null;
  resetsAt?: number;
}

/** An agent's account and plan limits, as the agent itself reports them. */
export interface PlanUsage {
  tool: Tool;
  account?: { email?: string; organization?: string; plan?: string; auth?: string };
  windows: PlanWindow[];
  /** Pay-as-you-go use beyond the plan, when the agent has it. */
  extra?: { enabled: boolean; used?: number | null; limit?: number | null; currency?: string | null };
  /** Where this period's use went (Claude: Claude Code, Chats ...). */
  breakdown?: { label: string; pct: number }[];
  /** When this was read, and from where. */
  at: number;
  source: string;
  /** Why there are no limits to show, said plainly. */
  note?: string;
}
