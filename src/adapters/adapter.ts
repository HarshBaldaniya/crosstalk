import type { ChatDigest, ChatMessage, ChatSession, ChatStats, Tool } from "../core/types";

/** What Crosstalk needs from each AI tool. One file per tool implements it. */
export interface Adapter {
  tool: Tool;
  /** The tool has left chats on this computer. */
  present(): boolean;
  /** Chats started in this folder, newest first; with no folder, the newest chats of every folder. */
  list(root: string | undefined, limit: number): Promise<ChatSession[]>;
  /** The whole conversation, for context on connecting or branching. */
  read(chat: ChatSession, root: string): Promise<ChatDigest>;
  /** Tokens used (in total and today), the latest model and how full the context is. Cached, read incrementally. */
  usage(chat: ChatSession): ChatStats | undefined;
  /** Bytes of the chat's file not yet counted for usage (absent: counting is always quick). */
  pendingBytes?(chat: ChatSession): number;
  /** Counts one more slice of a big chat file (absent: `usage` reads it in one go). */
  usageStep?(chat: ChatSession, maxBytes: number): void;
  /** Keeps what has been counted for the next window. */
  saveCache?(): void;
  /** The latest model and how full the context is, read cheaply (for chats from other folders). */
  latest(chat: ChatSession): Pick<ChatStats, "model" | "context"> | undefined;
  /** A cursor at the end of the chat now: updates start from here. */
  end(chat: ChatSession): number;
  /** What was said since `cursor`, and the cursor after it. */
  since(chat: ChatSession, cursor: number): { messages: ChatMessage[]; files: string[]; next: number };
  /** The terminal command that resumes a chat (tools without an editor extension). */
  resumeCommand?(chat: ChatSession): string;
  /** The terminal command that starts a new chat. */
  newCommand?(): string;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
