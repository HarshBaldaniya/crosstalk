// Messages between the extension and its webviews (the sidebar and the board).
import type { BoardArrange, BoardPosition, BoardState, ChatSession, Connection, PlanUsage, Tool, Usage } from "./types";

export interface ConnectionView extends Connection {
  /** Pieces of context that reached the target. */
  updates: number;
  /** Characters delivered in total (tokens ≈ chars / 4). */
  chars: number;
  lastAt?: number;
}

export interface ToolTotals {
  chats: number;
  today: Usage;
  total: Usage;
}

export interface ViewState {
  root?: string;
  /** Tools that have chats on this computer. */
  tools: Tool[];
  sessions: ChatSession[];
  connections: ConnectionView[];
  /** Context waiting for each chat's next message. */
  /** Updates waiting for each chat's next message (notices about link changes are not counted). */
  inbox: Record<string, { count: number; chars: number; from: string[] }>;
  board: BoardState;
  totals: Partial<Record<Tool, ToolTotals>>;
  /** Crosstalk's hooks are in Claude Code's settings: status is live and connections deliver by themselves. */
  hooksOn: boolean;
  /** Per installed agent: Crosstalk's hook is in its settings. */
  hooks?: Partial<Record<Tool, boolean>>;
  /** The board has the whole window (side panels hidden). */
  focus?: boolean;
  /** Claude Code compacts chats by itself when they fill up. */
  autoCompact?: boolean;
  /** Each agent's account and plan limits, as the agent reports them. */
  plans?: Partial<Record<Tool, PlanUsage>>;
  /** Plan limits are being read right now. */
  plansLoading?: boolean;
  claudeExtension: boolean;
  loading: boolean;
  error?: string;
}

/** The Code page: the map of this folder, summed up for people. */
export interface CodeMapView {
  root: string;
  files: number;
  decls: number;
  bytes?: number;
  languages: Record<string, number>;
  modules: {
    id: string;
    files: number;
    rank: number;
    dependsOn: string[];
    doc: { status: "missing" | "draft" | "approved"; changed?: boolean; changedFiles?: number; approvedOn?: string };
    topFiles: { p: string; decls: number; importers: number }[];
    /** Its files by kind of code: component, hook, function ... */
    kinds: Record<string, number>;
  }[];
  /** Module → module imports, with how many */
  edges: { from: string; to: string; weight: number }[];
  unused: { files: number; exports: number; localOnly: number; sample: string[] };
  staleDocs: { file: string; line: number; missing: string }[];
  conventions: string[];
  /** Every file: its part, and how many files import it (the map's stars) */
  allFiles: { p: string; m: string; importers: number; k?: string }[];
  /** File imports as index pairs into allFiles: [importer, imported] */
  links: [number, number][];
  /** Projects on this computer that can be mapped: this window's folders, and the folders chats ran in */
  projects: { root: string; name: string; here: boolean }[];
  /** Still being built the first time */
  building?: boolean;
}

/** One module opened up on the map: its files and the imports between them. */
export interface CodeModuleView {
  id: string;
  files: { p: string; decls: number; importers: number; main?: string; kind?: string }[];
  edges: { from: string; to: string }[];
  /** Imports going out to other modules, per file */
  out: { from: string; module: string }[];
}

export interface CodeHitView {
  name: string;
  kind: string;
  path: string;
  start: number;
  end: number;
  usedBy: number;
  doc?: string;
}

/** The Library page. */
export interface LibraryView {
  packs: { id: string; title: string; blurb: string }[];
  commands: {
    name: string;
    title: string;
    pack: string;
    description: string;
    args: { name: string; description: string; required: boolean }[];
    needs?: string;
    /** "builtin", or the person's own file */
    source: string;
    /** Times used, from this computer's session logs */
    used: number;
  }[];
  agents: { id: string; name: string; present: boolean; tools: boolean; commands: number }[];
  folder: string;
}

export interface RunsView {
  runs: import("./runs").Run[];
  automations: import("./automations").Automation[];
  paused: boolean;
  templates: { index: number; name: string; kind: string; agent: string }[];
  audit: { at: number; automation: string; event: string; decision: "started" | "skipped"; why?: string; run?: string }[];
}


export interface Ask {
  id: string;
  text: string;
}

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "branchInfo"; id: string; title: string; tool: Tool; asks: Ask[]; contextChars: number }
  | { type: "peek"; id: string; title: string; text: string }
  | {
      type: "toast";
      text: string;
      tone?: "ok" | "warn";
      /** A short headline; `text` then explains it. */
      title?: string;
      icon?: "link" | "unlink" | "pause" | "play" | "sync" | "info";
      /** One click puts it back. */
      undo?: FromWebview;
    }
  | { type: "tab"; tab: BoardTab }
  | { type: "codeMap"; data: CodeMapView }
  /** A folder the person just picked to map: the Map page switches to it */
  | { type: "codeRoot"; root: string }
  | { type: "codeFind"; q: string; hits: CodeHitView[] }
  | { type: "codeModule"; data: CodeModuleView }
  | { type: "library"; data: LibraryView }
  | { type: "librarySuggest"; q: string; names: string[] }
  | { type: "runs"; data: RunsView }
  | { type: "models"; tool: Tool; models: ModelOption[]; error?: string };

export type BoardTab = "board" | "usage" | "code" | "library" | "runs";

/** A model a tool offers, as the tool itself describes it. */
export interface ModelOption {
  value: string;
  name: string;
  description: string;
  resolved?: string;
}

export type FromWebview =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "open"; id: string }
  | { type: "openInTerminal"; id: string }
  /** A chat of another folder: open that folder's own VS Code window, with this chat in Claude's panel. */
  | { type: "openInFolder"; id: string }
  | { type: "newChat"; tool: Tool }
  | { type: "openBoard"; tab?: BoardTab }
  | { type: "codeMap"; rebuild?: boolean; root?: string }
  | { type: "codeFind"; q: string; root?: string }
  | { type: "codeModule"; id: string; root?: string }
  | { type: "openFile"; path: string; line?: number; root?: string }
  | { type: "moduleDoc"; id: string; action: "draft" | "open" | "approve"; root?: string }
  | { type: "library" }
  | { type: "librarySuggest"; q: string }
  | { type: "libraryRun"; name: string }
  /** text: exactly what to type in the agent the person picked; Claude Code's form when left out */
  | { type: "libraryCopy"; name: string; text?: string }
  | { type: "libraryOpen"; name: string }
  | { type: "libraryNew" }
  /** Pick any folder on this computer and map it */
  | { type: "codeMapFolder" }
  | { type: "setUpToolkit" }
  | { type: "runs" }
  | { type: "runStart"; task: string; agents: ("claude" | "codex" | "gemini")[]; tokens?: number; minutes?: number; leases: string[] }
  | { type: "run"; id: string; action: "stop" | "apply" | "discard" | "log" | "open" }
  | { type: "stopAll" }
  | { type: "automation"; id: string; action: "on" | "off" | "remove" }
  | { type: "automationAdd"; index: number }
  | { type: "automationsPaused"; paused: boolean }
  | { type: "setup" }
  | { type: "connect"; from: string; to: string; both?: boolean }
  | { type: "connectMany"; pairs: [string, string][]; handles?: Record<string, { s: string; t: string }> }
  | { type: "syncNow"; id: string }
  | { type: "chatCommand"; id: string; command: "compact" | "model"; model?: string }
  | { type: "models"; tool: Tool }
  /** Read every agent's plan limits again now. */
  | { type: "plans" }
  | { type: "fullscreen" }
  | { type: "autoCompactOn" }
  | { type: "disconnect"; connectionId: string }
  | { type: "disconnectMany"; ids: string[] }
  | { type: "direction"; a: string; b: string; want: "both" | "ab" | "ba" }
  | { type: "pause"; connectionId: string; paused: boolean }
  | { type: "linkLevel"; ids: string[]; level: "ping" | "brief" | "full" }
  | { type: "askBranch"; id: string }
  | { type: "branch"; from: string; task: string; withContext: boolean; askIds: string[]; keepConnected: boolean }
  | { type: "peek"; id: string }
  | { type: "boardAdd"; id: string; x?: number; y?: number; open?: boolean }
  | { type: "boardRemove"; id: string }
  | { type: "move"; id: string; x: number; y: number }
  | { type: "arrange"; positions: Record<string, BoardPosition> }
  /** Take every card off the board (Undo puts them back with boardRestore). */
  | { type: "boardClear" }
  | { type: "boardRestore"; members: string[]; positions: Record<string, BoardPosition> }
  /** The board's layout was chosen on the board. */
  | { type: "boardArrange"; arrange: BoardArrange }
  | { type: "viewport"; viewport: { x: number; y: number; zoom: number } }
  /** The sidebar switched between this folder and every folder: the board follows (By links / By folder). */
  | { type: "scope"; scope: "here" | "all" };
