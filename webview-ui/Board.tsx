// The board: chats as cards on a canvas, links as moving lines.
//   • Drag a chat from the tray onto the canvas (or press +) to show it.
//   • Drag from a card's right dot to another card, or drop a card on a card, to link them.
//   • Click a line's label to pause, make it two-way or unlink.
//   • Tidy up lays the cards out by who shares with whom.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ConnectionMode,
  BaseEdge,
  Controls,
  ControlButton,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useInternalNode,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection as FlowConnection,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { BoardTab, ConnectionView, ViewState } from "../src/core/protocol";
import { Orbit, SquareSlash, Workflow } from "lucide-react";
import { RUNS_OFFERED } from "../src/core/offered";
import { PAGE_KEYS } from "./pagekeys";
import type { BoardArrange, BoardPosition, ChatSession } from "../src/core/types";
import { DRAG_TYPE, agoText, charsToTokens, contextPct, folderName, modelName, remember, remembered, send, tokens, whereItOpens } from "./api";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  Check,
  ExternalLink,
  GitBranch,
  I,
  Inbox,
  LayoutGrid,
  Link2,
  Maximize2,
  RefreshCw,
  Eye,
  Activity,
  CalendarDays,
  ChevronDown,
  LayoutDashboard,
  Network,
  ArrowUpRight,
  Eraser,
  Keyboard,
  ChevronRight,
  Scan,
  FolderOpen,
  Folder,
  FolderTree,
  Search as SearchIcon2,
  MessageSquareDot,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  Search,
  StatusChip,
  StatusDot,
  ToolMark,
  Unlink,
  X,
  Zap,
} from "./Icons";
import type { Modal } from "./Modals";
import { CompactButton, ModelPicker } from "./ChatControls";
import { UsageView } from "./Usage";
import { CodePage } from "./CodePage";
import { LibraryPage } from "./LibraryPage";
import { RunsPage } from "./RunsPage";
import { KeySheet, useDismiss } from "./Keys";

type CardLink = { id: string; title: string; dir: "out" | "in" | "both" };
/** `inPanel`: the card sits in its folder's panel ("By folder"), which already names the folder. */
type CardData = { s: ChatSession; links: CardLink[]; waiting?: number; from?: string[]; inPanel?: boolean };
type CardNode = Node<CardData, "chat">;
const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;
/** One line per pair of chats: one direction, or both. */
type LineData = { forward: ConnectionView; back?: ConnectionView; fresh: boolean; sides?: { s: string; t: string } };
type LineEdge = Edge<LineData, "link">;

/** Card-to-card linking: press Link on a card, then click another card. */
const LinkMode = createContext<{ from: string | null; start: (id: string) => void }>({ from: null, start: () => {} });

type ArrangeMode = "links" | "time" | "status" | "agent" | "folder";
interface Lane {
  label: string;
  /** A folder's row ("By folder"): its full path, and whether it is this window's folder. */
  folder?: string;
  here?: boolean;
  count: number;
  /** When anything in it last happened. */
  latest?: number;
  /** Where its cards sit (the panel drawn around them is a little larger). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The board never opens smaller than this: cards stay readable, and it scrolls for the rest. */
const READABLE = 0.8;

/** Room a group's panel keeps around its cards, and for its heading above them. */
// One spacing unit for the whole board: gaps between cards, a group panel's padding, and the
// space between panels (two units) all come from it, in every arrangement.
const UNIT = 24;
const LANE_PAD = UNIT;
// A group's heading: its 32-px tile with one unit above and below, like the panel's sides.
const LANE_HEAD = 80;

const CARD_W = 300;
const CARD_H = 160;
/** By links: room between columns for the line and its label; rows sit two units apart. */
const COL_GAP = 192;
const ROW_GAP = 48;
const LOOSE_GAP = 48;
const FRESH_MS = 12_000;

/** Typing in a field: single-key shortcuts stay out of the way. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function Board(props: { state: ViewState; setModal: (m: Modal) => void; tab: BoardTab; setTab: (t: BoardTab) => void }) {
  // The shortcuts sheet belongs to the whole window: the page's own keys, then the ones that work
  // everywhere. ? opens it on any page; Esc closes it before anything else hears the Esc.
  const [keysOpen, setKeysOpen] = useState(false);
  // T, U, M and C switch between the Tower, Fuel, the map and the commands (L stays the chat list).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && keysOpen) {
        e.stopImmediatePropagation();
        return setKeysOpen(false);
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "?") return setKeysOpen((v) => !v);
      if (k === "t") props.setTab("board");
      if (k === "u") props.setTab("usage");
      if (k === "m") props.setTab("code");
      if (k === "c") props.setTab("library");
      if (k === "w" && RUNS_OFFERED) props.setTab("runs");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props, keysOpen]);
  const tab = props.tab === "runs" && !RUNS_OFFERED ? "board" : props.tab;
  return (
    <div className="boardpage">
      <div className="boardtop">
        <div className="seg big" role="tablist">
          <button role="tab" aria-selected={props.tab === "board"} className={props.tab === "board" ? "on" : ""} onClick={() => props.setTab("board")} data-tip="Tower (T)">
            <LayoutGrid {...I} /> Tower
          </button>
          <button role="tab" aria-selected={props.tab === "usage"} className={props.tab === "usage" ? "on" : ""} onClick={() => props.setTab("usage")} data-tip="Fuel (U)">
            <BarChart3 {...I} /> Fuel
          </button>
          <button role="tab" aria-selected={tab === "code"} className={tab === "code" ? "on" : ""} onClick={() => props.setTab("code")} data-tip="Map of the code (M)">
            <Orbit {...I} /> <span className="tablabel">Map</span>
          </button>
          <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => props.setTab("library")} data-tip="Commands for your agents (C)">
            <SquareSlash {...I} /> <span className="tablabel">Commands</span>
          </button>
          {RUNS_OFFERED && (
            <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "on" : ""} onClick={() => props.setTab("runs")} data-tip="Runs and automations (W)">
              <Workflow {...I} /> <span className="tablabel">Runs</span>
            </button>
          )}
        </div>
        <span className="grow" />
        <button className={`keysbtn${keysOpen ? " on" : ""}`} onClick={() => setKeysOpen((v) => !v)} data-tip="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-expanded={keysOpen}>
          <Keyboard {...I} size={15} />
        </button>
        {!props.state.hooksOn && (
          <button className="btn small primary" onClick={() => send({ type: "setup" })}>
            <Zap {...I} /> Turn on auto-sharing
          </button>
        )}
      </div>
      {keysOpen && <KeySheet sections={PAGE_KEYS[tab]} close={() => setKeysOpen(false)} />}
      {tab === "usage" ? (
        <UsageView state={props.state} />
      ) : tab === "code" ? (
        <CodePage state={props.state} />
      ) : tab === "library" ? (
        <LibraryPage />
      ) : tab === "runs" ? (
        <RunsPage />
      ) : (
        <ReactFlowProvider>
          <Canvas state={props.state} setModal={props.setModal} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function Canvas({ state, setModal }: { state: ViewState; setModal: (m: Modal) => void }) {
  const flow = useReactFlow();
  const dragStart = useRef<BoardPosition | null>(null);
  const fitted = useRef(false);
  const initialised = useNodesInitialized();
  // The chat list starts open only when there is room for it beside the canvas.
  const [trayOpen, setTrayOpen] = useState<boolean>(remembered("tray", window.innerWidth > 900));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 4000);
    return () => clearInterval(t);
  }, []);

  const byId = useMemo(() => new Map(state.sessions.map((s) => [s.id, s])), [state.sessions]);
  // The layout is kept with the workspace (the extension stores it), so it survives closing the
  // board, and the sidebar's "All folders" sets it to By folder.
  // What the saved board says, read as it renders (so a board opened fresh never shows another
  // arrangement first); a pick made here shows at once, until the saved board says something new.
  const [picked, setArrangeMode] = useState<ArrangeMode | "free" | undefined>();
  useEffect(() => setArrangeMode(undefined), [state.board.arrange]);
  const arrangeMode: ArrangeMode | "free" = (() => {
    const m = picked ?? state.board.arrange ?? remembered<ArrangeMode | "free">("arrangeMode", "links");
    return m === "status" ? "links" : m;
  })();
  // Every arrangement shows the board's own cards: what the person put on it (so clearing it
  // really clears it), added back a folder at a time or one by one from the chat list.
  const members = useMemo(() => state.board.members.filter((id) => byId.has(id)), [state.board.members, byId]);
  const memberSet = useMemo(() => new Set(members), [members]);

  // Every arrangement is live and follows the data; "free" is the person's own layout after a drag.
  // By links is the default.
  const [measureTick, setMeasureTick] = useState(0);
  const live = arrangeMode !== "free";
  // Rows hold as many cards as fit the board at a readable size (up to four).
  // The room the board shows at a readable size, in board units (in steps, so a small resize
  // doesn't shuffle the cards). Group layouts are cut to fit it: panels no taller than the board,
  // as many side by side as fit across.
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const step = (n: number) => Math.max(320, Math.round(n / 80) * 80);
  const viewW = paneW > 0 ? step((paneW - 64) / READABLE) : 1440;
  const viewH = paneH > 0 ? step((paneH - 84 - 28) / READABLE) : 960;
  const liveLayout = useMemo(() => {
    if (!live) return null;
    const sizes: Record<string, { w: number; h: number }> = {};
    for (const n of flow.getNodes()) if (n.type === "chat") sizes[n.id] = { w: n.measured?.width ?? CARD_W, h: n.measured?.height ?? 230 };
    if (arrangeMode === "links") return { positions: autoLayout(members, state.connections, sizes), lanes: [] as Lane[] };
    return laneLayout(
      members.map((id) => byId.get(id)!),
      arrangeMode as Exclude<ArrangeMode, "links">,
      sizes,
      state.root,
      { w: viewW, h: viewH },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, arrangeMode, members, byId, measureTick, state.connections, state.root, viewW, viewH]);
  const lanes: Lane[] = liveLayout?.lanes ?? [];

  const wanted = useMemo<CardNode[]>(() => {
    const auto = autoLayout(members, state.connections);
    return members.map((id) => ({
      id,
      type: "chat",
      dragHandle: ".bcardhead",
      position: liveLayout?.positions[id] ?? state.board.positions[id] ?? auto[id],
      data: {
        s: byId.get(id)!,
        links: cardLinks(id, state.connections),
        waiting: state.inbox[id]?.count,
        from: state.inbox[id]?.from,
        inPanel: arrangeMode === "folder",
      },
    }));
  }, [members, byId, state.board.positions, state.connections, state.inbox, liveLayout, arrangeMode]);

  const wantedEdges = useMemo<LineEdge[]>(() => {
    const out: LineEdge[] = [];
    const seen = new Set<string>();
    for (const c of state.connections) {
      if (!memberSet.has(c.from.id) || !memberSet.has(c.to.id) || seen.has(c.id)) continue;
      const back = state.connections.find((r) => r.from.id === c.to.id && r.to.id === c.from.id);
      seen.add(c.id);
      if (back) seen.add(back.id);
      const last = Math.max(c.lastAt ?? 0, back?.lastAt ?? 0);
      // The sides the person drew it between; a two-way link drawn the other way uses those, mirrored.
      const handles = state.board.handles ?? {};
      const fwd = handles[`${c.from.id}>${c.to.id}`];
      const rev = back ? handles[`${c.to.id}>${c.from.id}`] : undefined;
      const sides = fwd ?? (rev ? { s: rev.t, t: rev.s } : undefined);
      out.push({ id: c.id, source: c.from.id, target: c.to.id, type: "link", data: { forward: c, back, fresh: now - last < FRESH_MS, sides } });
    }
    return out;
  }, [state.connections, memberSet, now, state.board.handles]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CardNode>(wanted);
  // Places set here (a drop, a card pushed down) until Crosstalk's saved layout says the same: so a card
  // never jumps back to where it was while the save is on its way.
  const placed = useRef<Record<string, BoardPosition>>({});
  const viewSave = useRef<ReturnType<typeof setTimeout>>(undefined);
  const framedCount = useRef(0);
  const place = useCallback((moves: Record<string, BoardPosition>) => Object.assign(placed.current, moves), []);
  useEffect(() => {
    for (const [id, p] of Object.entries(placed.current)) {
      const saved = state.board.positions[id];
      if (saved && Math.abs(saved.x - p.x) < 1 && Math.abs(saved.y - p.y) < 1) delete placed.current[id];
    }
  }, [state.board.positions]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<LineEdge>(wantedEdges);
  useEffect(() => {
    setNodes((cur) => {
      const was = new Map(cur.map((n) => [n.id, n]));
      // Keep what React Flow knows about each card (its measured size, selection, drag): a card
      // without its measured size is hidden by React Flow and stops taking clicks.
      return wanted.map((n) => {
        const old = was.get(n.id);
        return {
          ...old,
          ...n,
          measured: old?.measured,
          selected: old?.selected,
          dragging: old?.dragging,
          // Arranged: where the arrangement puts it. By hand: where the person put it (as saved),
          // never where an arrangement shown a moment before had put it.
          position:
            liveLayout?.positions[n.id] ??
            (old?.dragging ? old.position : undefined) ??
            placed.current[n.id] ??
            state.board.positions[n.id] ??
            old?.position ??
            n.position,
        };
      });
    });
  }, [wanted, setNodes, state.board.positions, liveLayout]);
  // Lay out again whenever a card's real height changes (a link adds a line, a chat starts
  // waiting...), so cards never overlap or spill out of their group's panel.
  const heights = useMemo(() => nodes.map((n) => `${n.id}:${Math.round(n.measured?.height ?? 0)}`).join(","), [nodes]);
  useEffect(() => {
    if (initialised) setMeasureTick((t) => t + 1);
  }, [initialised, heights]);
  // Placed by hand ("free"), cards stay where the person put them, but a card that grows (its
  // folder line back after leaving "By folder", a new link, a chat waiting...) pushes the cards
  // under it down, so every card stays one unit clear of the next. Nothing is ever pulled up.
  useEffect(() => {
    if (live || !initialised) return;
    const cards = flow.getNodes().filter((n) => n.type === "chat");
    if (!cards.length || cards.some((n) => n.dragging || !n.measured?.height)) return;
    const moved = spreadDown(cards.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? CARD_W, h: n.measured!.height! })));
    if (!Object.keys(moved).length) return;
    place(moved);
    setNodes((ns) => ns.map((n) => (moved[n.id] ? { ...n, position: moved[n.id] } : n)));
    send({ type: "arrange", positions: moved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, initialised, heights]);
  useEffect(() => setEdges(wantedEdges), [wantedEdges, setEdges]);
  // Frames every card, and in a layout with rows the row headings above them too (fitting the
  // cards alone left the first heading under the toolbar).
  const frame = useCallback(
    (mode: ArrangeMode | "free", opts: { duration?: number } = {}) => {
      const ns = flow.getNodes();
      const pane = document.querySelector(".canvas .react-flow") as HTMLElement | null;
      if (!ns.length || !pane) return;
      const b = flow.getNodesBounds(ns);
      const head = 0; // group panels are nodes: their headings are inside the bounds
      void mode;
      const W = pane.clientWidth;
      const H = pane.clientHeight;
      const top = 84; // below the toolbar
      const side = 32;
      const fit = Math.min((W - 2 * side) / b.width, (H - top - 28) / (b.height + head));
      const zoom = Math.min(1, Math.max(READABLE, fit));
      const wide = b.width * zoom;
      // Centred when it fits across, from the left edge when it doesn't; always from the top.
      const x = wide <= W - 2 * side ? (W - wide) / 2 - b.x * zoom : side - b.x * zoom;
      const y = top - (b.y - head) * zoom;
      flow.setViewport({ x, y, zoom }, { duration: opts.duration });
    },
    [flow],
  );
  // Fit once the cards have been measured, and again whenever the layout itself changes shape
  // (another arrangement, more or fewer cards per row, cards added or taken off), once it has settled.
  useEffect(() => {
    if (!initialised || !nodes.length) return;
    const first = !fitted.current;
    fitted.current = true;
    const added = nodes.length !== framedCount.current;
    framedCount.current = nodes.length;
    // Laid out by hand, the board opens where the person left the view, and keeps it (a drag into
    // "free" doesn't move the view); only cards added or taken off frame it again. An arrangement is framed.
    const saved = first && arrangeMode === "free" ? state.board.viewport : undefined;
    if (!first && arrangeMode === "free" && !added) return;
    const t = setTimeout(() => (saved ? flow.setViewport(saved) : frame(arrangeMode, first ? {} : { duration: 300 })), first ? 0 : 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialised, nodes.length, flow, arrangeMode, viewW, viewH, lanes.length]);

  const link = useCallback((from: string, to: string) => from !== to && send({ type: "connect", from, to }), []);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const arrangeRef = useRef<HTMLDivElement>(null);
  useDismiss(arrangeOpen, arrangeRef, () => setArrangeOpen(false));
  const [query, setQuery] = useState("");
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const linkMode = useMemo(() => ({ from: linkFrom, start: (id: string) => setLinkFrom((cur) => (cur === id ? null : id)) }), [linkFrom]);
  useEffect(() => {
    if (!linkFrom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setLinkFrom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linkFrom]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? members.filter((id) => byId.get(id)!.title.toLowerCase().includes(q)) : []), [q, members, byId]);
  // Group panels ("By time", "By agent", "By folder") are nodes drawn behind the cards.
  const laneNodes = useMemo<Node[]>(
    () =>
      lanes.map((l) => ({
        id: `lane:${l.folder ?? l.label}`,
        type: "lane",
        position: { x: l.x - LANE_PAD, y: l.y - LANE_HEAD },
        data: { lane: l },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        zIndex: -1,
        // Their size is known exactly, so they never wait to be measured (an unmeasured node is hidden).
        width: l.w + 2 * LANE_PAD,
        height: l.h + LANE_HEAD + LANE_PAD,
        measured: { width: l.w + 2 * LANE_PAD, height: l.h + LANE_HEAD + LANE_PAD },
        style: { width: l.w + 2 * LANE_PAD, height: l.h + LANE_HEAD + LANE_PAD },
      })),
    [lanes],
  );
  const shownNodes = useMemo<Node[]>(
    () => [...laneNodes, ...(q ? nodes.map((n) => ({ ...n, className: matches.includes(n.id) ? "match" : "dimmed" })) : nodes)],
    [laneNodes, nodes, q, matches],
  );
  const focusMatches = () => matches.length && flow.fitView({ nodes: matches.map((id) => ({ id })), padding: 0.4, maxZoom: 1, duration: 400 });
  const nodeTypes = useMemo(() => ({ chat: ChatCard, lane: LaneBox }), []);
  const edgeTypes = useMemo(() => ({ link: LinkLine }), []);
  const dark = !document.body.classList.contains("vscode-light") && !document.body.classList.contains("vscode-high-contrast-light");
  const toggleTray = () => {
    setTrayOpen((v) => {
      remember("tray", !v);
      return !v;
    });
  };
  const [connecting, setConnecting] = useState(false);
  const selected = nodes.filter((n) => n.selected).map((n) => n.id);
  /** A line drawn to or from a selected group links the whole group. */
  const linkFromLine = (source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null) => {
    if (source === target) return;
    const handles = sourceHandle && targetHandle ? { [`${source}>${target}`]: { s: sourceHandle, t: targetHandle } } : undefined;
    let pairs: [string, string][] = [[source, target]];
    if (selected.length > 1 && selected.includes(source) && !selected.includes(target)) pairs = selected.map((id) => [id, target]);
    else if (selected.length > 1 && selected.includes(target) && !selected.includes(source)) pairs = selected.map((id) => [source, id]);
    send({ type: "connectMany", pairs, handles });
  };
  const linkAllTogether = () => {
    const pairs: [string, string][] = [];
    for (const a of selected) for (const b of selected) if (a !== b) pairs.push([a, b]);
    send({ type: "connectMany", pairs });
  };
  const tidy = (mode: ArrangeMode) => {
    setArrangeOpen(false);
    setArrangeMode(mode);
    remember("arrangeMode", mode);
    send({ type: "boardArrange", arrange: mode as BoardArrange });
    setTimeout(() => frame(mode, { duration: 350 }), 60);
  };

  // ---- keyboard ----
  const searchRef = useRef<HTMLInputElement>(null);
  const focusOn = !!state.focus;
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    // ⌘F / Ctrl+F and / : find a chat on the board.
    if ((mod && e.key.toLowerCase() === "f") || (!mod && e.key === "/" && !typing(e))) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }
    if (e.key === "Escape") {
      // One step back at a time: the open menu, linking, the search, the selection, then focus.
      if (arrangeOpen) return setArrangeOpen(false);
      if (linkFrom) return setLinkFrom(null);
      if (query) return setQuery("");
      if (flow.getNodes().some((n) => n.selected)) return setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
      if (focusOn) return send({ type: "fullscreen" });
      return;
    }
    if (typing(e) || mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "f") {
      send({ type: "fullscreen" });
      setTimeout(() => frame(arrangeMode, { duration: 300 }), 450);
      return;
    }
    if (k === "l") return toggleTray();
    if (k === "n") return send({ type: "newChat", tool: "Claude" });
    if (k === "0") return frame(arrangeMode, { duration: 300 });
    const byNumber: Record<string, ArrangeMode> = { "1": "links", "2": "time", "3": "agent", "4": "folder" };
    if (byNumber[k] && members.length) return tidy(byNumber[k]);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="boardbody">
      {/* The chat list slides in and out (it stays mounted, so closing animates too); the board
          eases over to make room. Closed, it is inert: no focus or clicks reach it. */}
      <div className={`traywrap ${trayOpen ? "open" : ""}`} aria-hidden={!trayOpen} inert={!trayOpen}>
        <Tray state={state} onBoard={memberSet} close={toggleTray} />
      </div>
      <div
        className={`canvas ${connecting ? "is-connecting" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(DRAG_TYPE);
          if (!id) return;
          e.preventDefault();
          const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          send({ type: "boardAdd", id, x: p.x - CARD_W / 2, y: p.y - 30 });
        }}
      >
        <LinkMode.Provider value={linkMode}>
        <ReactFlow
          onMoveEnd={(_, v) => {
            // Kept with the board (a moment after the view stops moving), for the next time it opens.
            clearTimeout(viewSave.current);
            viewSave.current = setTimeout(() => send({ type: "viewport", viewport: { x: Math.round(v.x), y: Math.round(v.y), zoom: Math.round(v.zoom * 1000) / 1000 } }), 400);
          }}
          nodes={shownNodes as CardNode[]}
          onNodeClick={(_, node) => {
            if (linkFrom && node.id !== linkFrom) {
              send({ type: "connectMany", pairs: [[linkFrom, node.id]] });
              setLinkFrom(null);
            }
          }}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          colorMode={dark ? "dark" : "light"}
          minZoom={0.3}
          maxZoom={1.6}
          nodesConnectable
          deleteKeyCode={["Backspace", "Delete"]}
          onEdgesDelete={(es) => send({ type: "disconnectMany", ids: es.flatMap((e) => [e.data?.forward?.id, e.data?.back?.id].filter((x): x is string => !!x)) })}
          onNodesDelete={(ns) => ns.forEach((n) => send({ type: "boardRemove", id: n.id }))}
          connectionRadius={26}
          connectionMode={ConnectionMode.Loose}
          connectOnClick
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={() => setConnecting(false)}
          multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          proOptions={{ hideAttribution: true }}
          isValidConnection={(c) => c.source !== c.target}
          snapToGrid
          snapGrid={[UNIT / 2, UNIT / 2]}
          onConnect={(c: FlowConnection) => c.source && c.target && linkFromLine(c.source, c.target, c.sourceHandle, c.targetHandle)}
          onNodeDragStart={(_, node) => (dragStart.current = { ...node.position })}
          onNodeDragStop={(_, node) => {
            const hit = flow.getIntersectingNodes(node).find((n) => n.id !== node.id && n.type === "chat");
            if (hit && dragStart.current) {
              // A card dropped on a card links them; it goes back to where it was.
              const back = dragStart.current;
              setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: back } : n)));
              link(node.id, hit.id);
            } else {
              // Dropped close to another card: moved to the nearest spot one unit clear of every card.
              const others = flow.getNodes().filter((n) => n.type === "chat" && n.id !== node.id).map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? CARD_W, h: n.measured?.height ?? CARD_H }));
              const settled = clearOf(node.position, { w: node.measured?.width ?? CARD_W, h: node.measured?.height ?? CARD_H }, others);
              if (settled.x !== node.position.x || settled.y !== node.position.y) setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: settled } : n)));
              node = { ...node, position: settled };
              place({ [node.id]: settled });
              if (live) {
                // Moving a card by hand leaves the live columns: the layout becomes the person's own.
                const positions: Record<string, BoardPosition> = {};
                for (const n of flow.getNodes()) if (n.type === "chat") positions[n.id] = n.id === node.id ? node.position : n.position;
                place(positions);
                setArrangeMode("free");
                remember("arrangeMode", "free");
                send({ type: "arrange", positions });
                send({ type: "boardArrange", arrange: "free" });
              } else {
                send({ type: "move", id: node.id, x: node.position.x, y: node.position.y });
              }
            }
            dragStart.current = null;
          }}
        >
          <Background gap={22} size={1.2} />

          {linkFrom && (
            <Panel position="top-center" className="selbar linkbanner">
              <Link2 {...I} size={14} />
              <span>
                Click a card to link it with <b>{byId.get(linkFrom)?.title}</b>
              </span>
              <button className="btn small ghost" onClick={() => setLinkFrom(null)}>
                Cancel
              </button>
            </Panel>
          )}
          {selected.length > 1 && (
            <Panel position="top-center" className="selbar">
              <span>
                <b>{selected.length} chats selected.</b> Draw a line to or from any of them to link the whole group.
              </span>
              <button className="btn small primary" onClick={linkAllTogether}>
                <ArrowLeftRight {...I} size={13} /> Link all together
              </button>
              <button className="btn small ghost" onClick={() => setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))}>
                Clear
              </button>
            </Panel>
          )}
          <Panel position="top-left" className="toolbar">
            <button className="tbtn" onClick={toggleTray} data-tip={trayOpen ? "Hide the chat list (L)" : "Show the chat list (L)"} aria-label={trayOpen ? "Hide the chat list" : "Show the chat list"}>
              {trayOpen ? <PanelLeftClose {...I} size={15} /> : <PanelLeftOpen {...I} size={15} />}
            </button>
            <span className="tsep" />
            <label className="tsearch">
              <SearchIcon2 {...I} size={14} />
              <input
                ref={searchRef}
                placeholder="Find a chat"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") focusMatches();
                  if (e.key === "Escape") {
                    setQuery("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Find a chat on the Tower"
              />
              {q && <span className="tcount">{matches.length}</span>}
            </label>
            <span className="tsep" />
            <div className="tmenuwrap" ref={arrangeRef}>
              <button className="tbtn" onClick={() => setArrangeOpen((v) => !v)} disabled={!members.length} aria-expanded={arrangeOpen} data-tip="Lay the cards out (1 channels · 2 time · 3 agent · 4 folder)">
                <LayoutDashboard {...I} size={15} />{" "}
                <span className="tlabel">
                  Arrange{live ? <span className="tmode"> · {({ links: "Channels", time: "Time", status: "Status", agent: "Agent", folder: "Folder" } as const)[arrangeMode as ArrangeMode]}</span> : null}
                </span>{" "}
                <ChevronDown {...I} size={12} />
              </button>
              {arrangeOpen && (
                <div className="tmenu" role="menu">
                  {(
                    [
                      ["links", Network, "By channels", "Who shares with whom, left to right"],
                      ["time", CalendarDays, "By time", "Today, yesterday, this week, older"],
                      ["agent", LayoutDashboard, "By agent", "Claude, Codex, Gemini"],
                      ["folder", FolderTree, "By folder", "One row per project, channels across them"],
                    ] as const
                  ).map(([mode, Icon, label, hint]) => (
                    <button key={mode} role="menuitemradio" aria-checked={arrangeMode === mode} className={arrangeMode === mode ? "on" : ""} onClick={() => tidy(mode)}>
                      <Icon {...I} size={14} />
                      <span>
                        {label}
                        <small>{hint}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className={`tbtn ${state.focus ? "on" : ""}`}
              onClick={() => {
                send({ type: "fullscreen" });
                setTimeout(() => flow.fitView({ padding: 0.22, maxZoom: 1, duration: 350 }), 450);
              }}
              data-tip={state.focus ? "Leave focus: bring the side panels back (Esc or F)" : "Focus: give the Tower the whole window (F)"}
              aria-label={state.focus ? "Leave focus" : "Focus"}
            >
              {state.focus ? <Minimize2 {...I} size={15} /> : <Maximize2 {...I} size={15} />}
              <span className="tlabel">{state.focus ? "Exit focus" : "Focus"}</span>
            </button>
            {members.length > 0 && (
              <button className="tbtn" onClick={() => send({ type: "boardClear" })} data-tip="Take every card off the Tower (Undo brings them back)" aria-label="Clear the Tower">
                <Eraser {...I} size={15} /> <span className="tlabel">Clear</span>
              </button>
            )}
            <span className="tsep" />
            <button className="tbtn" onClick={() => send({ type: "newChat", tool: "Claude" })} data-tip="New Claude chat (N)">
              <Plus {...I} size={15} /> <span className="tlabel">New chat</span>
            </button>
          </Panel>
          {/* What the line styles mean, only while there are lines to read. */}
          {edges.length > 0 && (
            <Panel position="bottom-left" className="legendpanel">
              <span className="legend">
                <span className="swatch live" /> sharing
              </span>
              <span className="legend">
                <span className="swatch paused" /> paused
              </span>
            </Panel>
          )}
          <Controls showInteractive={false} showFitView={false} position="bottom-right">
            {/* Fit: every card at a readable size, from the top (React Flow's own fit shrinks a big board to specks). */}
            <ControlButton onClick={() => frame(arrangeMode, { duration: 300 })} aria-label="Fit the Tower" title="Fit the Tower (0)">
              <Scan {...I} size={13} />
            </ControlButton>
          </Controls>
        </ReactFlow>
        </LinkMode.Provider>
        {!state.loading && members.length === 0 && (
          <div className="boardempty">
            <span className="emptyicon">
              <LayoutGrid {...I} size={22} />
            </span>
            <p className="strong">Your Tower is empty</p>
            <p className="muted small">Add the chats you want to see: a whole folder at once, or one by one from the list.</p>
            <div className="boardemptyactions">
              {state.sessions.some((x) => !x.away) && (
                <button className="btn primary" onClick={() => state.sessions.filter((x) => !x.away).forEach((x) => send({ type: "boardAdd", id: x.id }))}>
                  <Plus {...I} size={13} /> Add {folderName(state.root) || "this folder"}’s chats
                </button>
              )}
              {!trayOpen && (
                <button className="btn" onClick={toggleTray}>
                  <PanelLeftOpen {...I} size={13} /> Show the chat list
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The chats not on the board yet, searchable, ready to drag in. */
/**
 * Chats not on the board, ready to add: grouped by folder (this window's first, then the most
 * recently active), each folder with Add all; a search over titles and folder names.
 */
function Tray({ state, onBoard, close }: { state: ViewState; onBoard: Set<string>; close: () => void }) {
  const [q, setQ] = useState("");
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const folderOf = (s: ChatSession) => (s.away ? s.cwd : state.root) ?? state.root ?? "";
  const list = state.sessions.filter(
    (s) => !onBoard.has(s.id) && (!needle || s.title.toLowerCase().includes(needle) || folderName(folderOf(s)).toLowerCase().includes(needle)),
  );
  const groups = new Map<string, ChatSession[]>();
  for (const s of list) groups.set(folderOf(s), [...(groups.get(folderOf(s)) ?? []), s]);
  const order = [...groups.keys()].sort((a, b) =>
    a === state.root ? -1 : b === state.root ? 1 : Math.max(...groups.get(b)!.map((x) => x.lastModified)) - Math.max(...groups.get(a)!.map((x) => x.lastModified)),
  );
  // Two folders with the same name are told apart by their parent.
  const nameCount = new Map<string, number>();
  for (const f of order) nameCount.set(folderName(f), (nameCount.get(folderName(f)) ?? 0) + 1);
  const hintOf = (f: string) => ((nameCount.get(folderName(f)) ?? 0) > 1 ? folderName(f.replace(/[\\/][^\\/]+[\\/]?$/, "")) : "");
  // This folder starts open, the rest closed; a search opens every folder it finds something in.
  const isOpen = (f: string) => !!needle || (openFolders[f] ?? f === state.root);
  return (
    <aside className="tray" aria-label="Chats not on the Tower">
      <div className="trayhead">
        <span className="traytitle">Add to Tower</span>
        <button className="icon sm" onClick={close} aria-label="Hide the chat list" data-tip="Hide">
          <X {...I} />
        </button>
      </div>
      <div className="searchrow traysearch">
        <Search {...I} className="muted" />
        <input className="search" placeholder="Find a chat or folder" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a chat to add" />
        {q && (
          <button className="icon sm" aria-label="Clear" onClick={() => setQ("")}>
            <X {...I} size={12} />
          </button>
        )}
      </div>
      <div className="traylist">
        {order.map((f) => {
          const items = groups.get(f)!;
          const open = isOpen(f);
          const here = f === state.root;
          return (
            <section key={f} className="traygroup">
              <div className="traygrouphead">
                <button className="traygroupbtn" onClick={() => setOpenFolders((o) => ({ ...o, [f]: !open }))} aria-expanded={open}>
                  <ChevronRight {...I} size={13} className={`chev ${open ? "open" : ""}`} />
                  {here ? <FolderOpen {...I} size={13} className="tfolder here" /> : <Folder {...I} size={13} className="tfolder" />}
                  <span className="ellipsis">{folderName(f) || "This folder"}</span>
                  {hintOf(f) && <span className="fhint ellipsis">{hintOf(f)}</span>}
                  <span className="traycount">{items.length}</span>
                </button>
                <button className="trayaddall" onClick={() => items.forEach((s) => send({ type: "boardAdd", id: s.id }))} aria-label={`Add every chat of ${folderName(f)} to the board`}>
                  <Plus {...I} size={12} /> All
                </button>
              </div>
              {open &&
                items.map((s) => (
                  <div
                    key={s.id}
                    className="trayitem"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, s.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                  >
                    <span className={`traytile tool-${s.tool.toLowerCase()}`}>
                      <ToolMark tool={s.tool} size={13} />
                    </span>
                    <span className="traytext">
                      <span className="traytitleline">{s.title}</span>
                      <span className="traymeta">{agoText(s.lastModified)}</span>
                    </span>
                    <button className="icon sm addbtn" onClick={() => send({ type: "boardAdd", id: s.id })} aria-label={`Add “${s.title}” to the board`}>
                      <Plus {...I} />
                    </button>
                  </div>
                ))}
            </section>
          );
        })}
        {!list.length && <p className="muted small pad">{q ? "No chats match." : "Every chat is on the board."}</p>}
      </div>
    </aside>
  );
}



/** A group's panel behind its cards: its heading (a folder's tile, name, when it was last active, how many). */
const LaneBox = memo(function LaneBox({ data }: NodeProps<Node<{ lane: Lane }>>) {
  const l = data.lane;
  return (
    <div className={`lanebox ${l.folder ? "folder" : ""} ${l.here ? "here" : ""}`}>
      <div className="laneboxhead">
        {l.folder && <span className={`ftile ${l.here ? "here" : ""}`}>{l.here ? <FolderOpen {...I} size={15} /> : <Folder {...I} size={15} />}</span>}
        <span className="lanetitle">
          <span className="lanename ellipsis">{l.label}</span>
          {l.latest ? <span className="lanemeta">{agoText(l.latest)}</span> : null}
        </span>
        <span className="lanecount">{l.count}</span>
      </div>
    </div>
  );
});

const ChatCard = memo(function ChatCard({ data, selected }: NodeProps<CardNode>) {
  const { s, links, waiting } = data;
  const linkMode = useContext(LinkMode);
  const role = linkMode.from === s.id ? "linksource" : linkMode.from ? "linktarget" : "";
  // A short green flash when the chat finishes a reply.
  const prev = useRef(s.status);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = s.status;
    if (was !== s.status && s.status === "done" && was === "working") {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1600);
      return () => clearTimeout(t);
    }
  }, [s.status]);
  const pct = contextPct(s.context);
  const shown = links.slice(0, 2);
  return (
    <div className={`bcard ${s.status} tool-${s.tool.toLowerCase()} ${selected ? "selected" : ""} ${flash ? "justdone" : ""} ${role}`}>
      <div className="bcardhead">
        <span className="bcardlogo">
          <ToolMark tool={s.tool} size={20} />
        </span>
        <div className="bcardheading">
          <button className="bcardtitle nodrag nopan" onClick={() => send({ type: "open", id: s.id })} data-tip={s.title.length > 60 ? s.title : `Open in ${s.tool}`}>
            {s.title}
          </button>
          <div className="bcardsub">
            <StatusChip key={s.status} status={s.status} />
            <span className="muted small">{agoText(s.lastModified)}</span>
          </div>
        </div>
        {/* Corner actions float over the card on hover, so the title keeps the card's whole width. */}
        <span className="bcardcorner nodrag nopan">
          {s.away && (
            <button className="icon sm" onClick={() => send({ type: "openInFolder", id: s.id })} aria-label={`Open “${s.title}” in ${folderName(s.cwd)}`} data-tip={`Open in ${folderName(s.cwd)}, ${whereItOpens(s.tool)}`}>
              <FolderOpen {...I} />
            </button>
          )}
          <button className="icon sm" onClick={() => send({ type: "boardRemove", id: s.id })} aria-label={`Take “${s.title}” off the board`} data-tip="Take off the Tower">
            <X {...I} />
          </button>
        </span>
      </div>
      {s.status === "waiting" && s.lastLine && <div className="bcardattn">{s.lastLine}</div>}
      {(s.model || s.context || links.length > 0 || (s.away && !data.inPanel)) && (
        <dl className="bcardfacts">
          {s.away && !data.inPanel && (
            <>
              <dt>Folder</dt>
              <dd className="bfolder">
                <button className="bfolderbtn nodrag nopan" onClick={() => send({ type: "openInFolder", id: s.id })} data-tip={`Open ${folderName(s.cwd)} in its own window, ${whereItOpens(s.tool)}`}>
                  <Folder {...I} size={12} />
                  <span className="ellipsis">{folderName(s.cwd)}</span>
                  <ArrowUpRight {...I} size={12} />
                </button>
              </dd>
            </>
          )}
          {s.model && (
            <>
              <dt>Model</dt>
              <dd>
                <ModelPicker s={s} />
              </dd>
            </>
          )}
          {s.context && pct !== undefined && (
            <>
              <dt>Context</dt>
              <dd className="ctx" data-tip={`${s.context.used.toLocaleString()} of ${s.context.window.toLocaleString()} tokens`}>
                <span className={`ctxbar ${pct >= 90 ? "full" : pct >= 70 ? "high" : "ok"}`}>
                  <span style={{ width: `${Math.max(2, pct)}%` }} />
                </span>
                {pct}%
                <CompactButton s={s} />
              </dd>
            </>
          )}
          {links.length > 0 && (
            <>
              <dt>Connected</dt>
              <dd className="bcardlinks">
                {shown.map((l) => (
                  <span key={l.id} className={`bcardlink ${l.dir}`} data-tip={l.dir === "both" ? "Shares both ways" : l.dir === "out" ? "Shares with it" : "Learns from it"}>
                    {l.dir === "both" ? <ArrowLeftRight {...I} size={11} /> : l.dir === "out" ? <ArrowRight {...I} size={11} /> : <ArrowLeft {...I} size={11} />}
                    <span className="ellipsis">{l.title}</span>
                  </span>
                ))}
                {links.length > shown.length && <span className="muted small">+{links.length - shown.length} more</span>}
              </dd>
            </>
          )}
        </dl>
      )}
      {!!waiting && (
<div key={waiting} className="incoming nodrag nopan">
          <div className="inhead">
            <span className="inicon" aria-hidden="true">
              <MessageSquareDot {...I} size={15} />
            </span>
            <span className="intext">
              <b>
                {waiting} update{waiting === 1 ? "" : "s"} on the way
              </b>
              <span className="insub">from {(data.from ?? []).join(", ") || "linked chats"}</span>
            </span>
          </div>
          <div className="inactions">
            <button className="btn tiny ghost" onClick={() => send({ type: "peek", id: s.id })}>
              <Eye {...I} size={12} /> View
            </button>
            <button className="btn tiny primary" onClick={() => send({ type: "syncNow", id: s.id })} data-tip="They arrive by themselves when the chat replies or gets its next message. Sync sends them now.">
              <RefreshCw {...I} size={12} /> Sync
            </button>
          </div>
        </div>
      )}
      <div className="bcardactions nodrag nopan">
        <button className="btn small" onClick={() => send({ type: "open", id: s.id })}>
          <ExternalLink {...I} size={13} /> Open
        </button>
        <button className="btn small ghost" onClick={() => send({ type: "askBranch", id: s.id })} data-tip="Start a new chat for a separate task, with this chat's context">
          <GitBranch {...I} size={13} /> New task
        </button>
      </div>
      {SIDES.map(([side, pos]) => (
        <Handle key={side} id={side} type="source" position={pos} className={`port ${side}`} data-tip="Drag (or click) to connect to another chat" />
      ))}
    </div>
  );
});

type LinkLevelName = "ping" | "brief" | "full";
/** How much a link sends: a line per ask is plenty to stay in step, and costs the least. */
const LINK_LEVEL_OPTIONS: { key: LinkLevelName; label: string; hint: string; tip: string }[] = [
  { key: "ping", label: "Ping", hint: "A line per ask · fewest tokens", tip: "What was asked and what was done, one line each. The rest is in the chat's flightlog." },
  { key: "brief", label: "Brief", hint: "Asked, done, open, files", tip: "A short paragraph per ask: what was asked, what was done, what is open, files and PRs." },
  { key: "full", label: "Full", hint: "The words themselves · most tokens", tip: "Every ask and reply word for word, up to a cap. Costs the most." },
];

/** The chats a card is linked with, one entry each, whichever way the work flows. */
function cardLinks(id: string, conns: ConnectionView[]): CardLink[] {
  const by = new Map<string, CardLink>();
  for (const c of conns) {
    if (c.from.id === id) {
      const prev = by.get(c.to.id);
      by.set(c.to.id, { id: c.to.id, title: c.to.title, dir: prev?.dir === "in" ? "both" : "out" });
    } else if (c.to.id === id) {
      const prev = by.get(c.from.id);
      by.set(c.from.id, { id: c.from.id, title: c.from.title, dir: prev?.dir === "out" ? "both" : "in" });
    }
  }
  return [...by.values()];
}

/**
 * A link between the nearest sides of two cards. While it shares, glowing dots
 * travel along it the way the work flows (both ways for a two-way link); a
 * fresh update makes it glow and the dots hurry. A new link draws itself in.
 */
function LinkLine({ id, source, target, data }: EdgeProps<LineEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  const [menu, setMenu] = useState(false);
  // What the person just picked, shown at once until Crosstalk's own answer arrives (and replaces it).
  const [picked, setPicked] = useState<{ dir?: "both" | "ab" | "ba"; paused?: boolean; level?: LinkLevelName }>({});
  const answer = `${data?.forward.id}|${data?.back?.id}|${data?.forward.paused}|${data?.back?.paused}|${data?.forward.level}|${data?.back?.level}`;
  useEffect(() => setPicked({}), [answer]);
  const labelRef = useRef<HTMLDivElement>(null);
  // The menu closes on a click anywhere else, and on Esc.
  useDismiss(menu, labelRef, () => setMenu(false));
  if (!a || !b || !data) return null;
  const { sx, sy, tx, ty, sp, tp } = data.sides ? sideEnds(a, b, data.sides) : edgeEnds(a, b);
  const [path, lx, ly] = getBezierPath({ sourceX: sx, sourceY: sy, sourcePosition: sp, targetX: tx, targetY: ty, targetPosition: tp });
  const conns = [data.forward, data.back].filter((c): c is ConnectionView => !!c);
  const both = picked.dir ? picked.dir === "both" : !!data.back;
  const reversed = picked.dir === "ba";
  const paused = picked.paused ?? conns.every((c) => c.paused);
  const level: LinkLevelName = picked.level ?? conns[0]?.level ?? "ping";
  const updates = conns.reduce((n, c) => n + c.updates, 0);
  const chars = conns.reduce((n, c) => n + c.chars, 0);
  const tone = paused ? "paused" : "live";
  const setDirection = (want: "both" | "ab" | "ba") => {
    setPicked((p) => ({ ...p, dir: want }));
    send({ type: "direction", a: data.forward.from.id, b: data.forward.to.id, want });
  };
  const fromTool = data.forward.from.tool.toLowerCase();
  const toTool = data.forward.to.tool.toLowerCase();
  const dur = data.fresh ? 1.4 : 2.8;
  return (
    <g className={`link ${tone} ${data.fresh ? "fresh" : ""} ${menu ? "selected" : ""}`}>
      <defs>
        <linearGradient id={`g-${id}`} gradientUnits="userSpaceOnUse" x1={sx} y1={sy} x2={tx} y2={ty}>
          <stop offset="0" className={`stop tool-${fromTool}`} />
          <stop offset="1" className={`stop tool-${toTool}`} />
        </linearGradient>
      </defs>
      {!both && (
        <defs>
          <marker id={`end-${id}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M1 1 L9 5 L1 9" className={`arrowhead tool-${toTool}`} />
          </marker>
        </defs>
      )}
      <BaseEdge id={id} path={path} interactionWidth={26} style={{ stroke: "transparent" }} />
      <path d={path} className="linkglow" fill="none" style={paused ? undefined : { stroke: `url(#g-${id})` }} />
      <path d={path} className="linkbase" fill="none" pathLength={1} markerEnd={both ? undefined : `url(#end-${id})`} style={paused ? undefined : { stroke: `url(#g-${id})` }} />
      {!paused && <path d={path} className={`comet tool-${fromTool}`} fill="none" pathLength={100} style={{ animationDuration: `${dur}s` }} />}
      {!paused && both && <path d={path} className={`comet back tool-${toTool}`} fill="none" pathLength={100} style={{ animationDuration: `${dur}s`, animationDelay: `${-dur / 2}s` }} />}
      <EdgeLabelRenderer>
        <div ref={labelRef} className={`edgelabel nodrag nopan ${tone} ${data.fresh ? "fresh" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          <button className="edgepill" onClick={() => setMenu((v) => !v)} aria-expanded={menu} data-tip={paused ? "Paused: nothing is shared until you resume it. Click to change" : updates ? `${updates} update${updates === 1 ? "" : "s"} shared so far, about ${tokens(charsToTokens(chars))} tokens. Click to change this channel` : "Connected: the first update goes with the next reply. Click to change"}>
            <ToolMark tool={data.forward.from.tool} size={13} />
            {both ? <ArrowLeftRight {...I} size={12} /> : reversed ? <ArrowLeft {...I} size={12} /> : <ArrowRight {...I} size={12} />}
            <ToolMark tool={data.forward.to.tool} size={13} />
            <span className="pillsep" aria-hidden="true" />
            {paused ? "Paused" : updates ? `${updates} update${updates === 1 ? "" : "s"} · ~${tokens(charsToTokens(chars))}` : "Sharing"}
          </button>
          <button
            className="edgex"
            onClick={() => send({ type: "disconnectMany", ids: conns.map((c) => c.id) })}
            aria-label="Close channel"
            data-tip="Close channel"
          >
            <X {...I} size={11} />
          </button>
          {menu && (
            <div className="edgemenu" role="menu">
              <div className="menusection">Who shares with whom</div>
              {(
                [
                  { key: "both", Arrow: ArrowLeftRight, tip: "Both ways: each gets the other's work" },
                  { key: "ab", Arrow: ArrowRight, tip: `${data.forward.from.title} shares with ${data.forward.to.title}` },
                  { key: "ba", Arrow: ArrowLeft, tip: `${data.forward.to.title} shares with ${data.forward.from.title}` },
                ] as const
              ).map((o) => {
                const on = (both ? "both" : reversed ? "ba" : "ab") === o.key;
                return (
                  <button
                    key={o.key}
                    role="menuitemradio"
                    aria-checked={on}
                    aria-label={o.tip}
                    data-tip={o.tip}
                    className={`diropt ${on ? "on" : ""}`}
                    onClick={() => {
                      setDirection(o.key);
                      setMenu(false);
                    }}
                  >
                    <span className="check" aria-hidden="true">
                      {on ? <Check {...I} size={13} /> : null}
                    </span>
                    <span className="dirlabel">
                      <ToolMark tool={data.forward.from.tool} size={12} />
                      <span className="ellipsis">{data.forward.from.title}</span>
                      <o.Arrow {...I} size={14} className="dirarrow" />
                      <ToolMark tool={data.forward.to.tool} size={12} />
                      <span className="ellipsis">{data.forward.to.title}</span>
                    </span>
                  </button>
                );
              })}
              <div className="menusep" />
              <div className="menusection">What it sends after each reply</div>
              {LINK_LEVEL_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  role="menuitemradio"
                  aria-checked={level === o.key}
                  className={`diropt ${level === o.key ? "on" : ""}`}
                  data-tip={o.tip}
                  onClick={() => {
                    setPicked((p) => ({ ...p, level: o.key }));
                    send({ type: "linkLevel", ids: conns.map((c) => c.id), level: o.key });
                    setMenu(false);
                  }}
                >
                  <span className="check" aria-hidden="true">
                    {level === o.key ? <Check {...I} size={13} /> : null}
                  </span>
                  <span className="levellabel">
                    {o.label}
                    <small>{o.hint}</small>
                  </span>
                </button>
              ))}
              <div className="menusep" />
              <button role="menuitem" onClick={() => (setPicked((p) => ({ ...p, paused: !paused })), conns.forEach((c) => send({ type: "pause", connectionId: c.id, paused: !paused })), setMenu(false))}>
                <span className="check" aria-hidden="true">
                  {paused ? <Play {...I} size={13} /> : <Pause {...I} size={13} />}
                </span>
                {paused ? "Resume sharing" : "Pause sharing"}
              </button>
              <button role="menuitem" className="danger" onClick={() => (send({ type: "disconnectMany", ids: conns.map((c) => c.id) }), setMenu(false))}>
                <span className="check" aria-hidden="true">
                  <Unlink {...I} size={13} />
                </span>
                Close channel
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </g>
  );
}

const SIDE_POS: Record<string, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

/** A point on a card's side, for a line drawn to a particular dot. */
function sidePoint(n: InternalNode, side: string) {
  const w = n.measured.width ?? CARD_W;
  const h = n.measured.height ?? CARD_H;
  const p = n.internals.positionAbsolute;
  switch (side) {
    case "top":
      return { x: p.x + w / 2, y: p.y };
    case "bottom":
      return { x: p.x + w / 2, y: p.y + h };
    case "left":
      return { x: p.x, y: p.y + h / 2 };
    default:
      return { x: p.x + w, y: p.y + h / 2 };
  }
}

/** Line ends on the exact dots the person linked. */
function sideEnds(a: InternalNode, b: InternalNode, sides: { s: string; t: string }) {
  const s = sidePoint(a, sides.s);
  const t = sidePoint(b, sides.t);
  return { sx: s.x, sy: s.y, sp: SIDE_POS[sides.s] ?? Position.Right, tx: t.x, ty: t.y, tp: SIDE_POS[sides.t] ?? Position.Left };
}

/** Where a line leaves and enters two cards: the sides facing each other. */
function edgeEnds(a: InternalNode, b: InternalNode) {
  const box = (n: InternalNode) => {
    const w = n.measured.width ?? CARD_W;
    const h = n.measured.height ?? CARD_H;
    const p = n.internals.positionAbsolute;
    return { x: p.x, y: p.y, w, h, cx: p.x + w / 2, cy: p.y + h / 2 };
  };
  const A = box(a);
  const B = box(b);
  const dx = B.cx - A.cx;
  const dy = B.cy - A.cy;
  // Sideways when the cards sit more side by side than above each other.
  if (Math.abs(dx) * 0.6 >= Math.abs(dy)) {
    const right = dx > 0;
    return {
      sx: right ? A.x + A.w : A.x,
      sy: A.cy,
      sp: right ? Position.Right : Position.Left,
      tx: right ? B.x : B.x + B.w,
      ty: B.cy,
      tp: right ? Position.Left : Position.Right,
    };
  }
  const down = dy > 0;
  return {
    sx: A.cx,
    sy: down ? A.y + A.h : A.y,
    sp: down ? Position.Bottom : Position.Top,
    tx: B.cx,
    ty: down ? B.y : B.y + B.h,
    tp: down ? Position.Top : Position.Bottom,
  };
}

const LANE_GAP = 90;

/** Cards in labelled columns: by time, by status or by agent; newest first in each. */
function laneLayout(
  chats: ChatSession[],
  mode: Exclude<ArrangeMode, "links">,
  sizes: Record<string, { w: number; h: number }>,
  root: string | undefined,
  view: { w: number; h: number },
): { positions: Record<string, BoardPosition>; lanes: Lane[] } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const folderOf = (c: ChatSession) => (c.away ? c.cwd : root) ?? root ?? "";
  const key = (c: ChatSession): string => {
    if (mode === "folder") return folderOf(c);
    if (mode === "agent") return c.tool;
    if (mode === "status") return ({ waiting: "Needs you", working: "Working", done: "Done", idle: "Idle" } as const)[c.status];
    if (c.lastModified >= today) return "Today";
    if (c.lastModified >= today - 86_400_000) return "Yesterday";
    if (c.lastModified >= today - 6 * 86_400_000) return "This week";
    return "Older";
  };
  const groups = new Map<string, ChatSession[]>();
  for (const c of [...chats].sort((a, b) => b.lastModified - a.lastModified)) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  const order = (
    mode === "folder"
      ? // This window's folder first, the others by their newest chat (groups were filled newest first).
        [...groups.keys()].sort((a, b) => (a === root ? -1 : b === root ? 1 : 0))
      : mode === "agent"
        ? ["Claude", "Codex", "Gemini"]
        : mode === "status"
          ? ["Needs you", "Working", "Done", "Idle"]
          : ["Today", "Yesterday", "This week", "Older"]
  ).filter((k) => groups.get(k)?.length);
  const labelOf = (k: string) => (mode === "folder" ? folderName(k) || "Other" : k);

  // Both ways at once, cut to the board's size:
  //   - a panel is never taller than the board: a group with many chats spreads sideways into
  //     more columns instead of growing down (cards read across, newest first);
  //   - panels flow left to right, and wrap to a new band below once the board's width is used.
  const GAP_X = UNIT;
  const GAP_Y = UNIT;
  const BETWEEN = 2 * UNIT;
  const hOf = (c: ChatSession) => sizes[c.id]?.h ?? CARD_H + 70;
  const all = chats.map(hOf).sort((a, b) => a - b);
  const typical = all.length ? all[Math.floor(all.length / 2)] : CARD_H + 70;
  const maxRows = Math.max(1, Math.floor((view.h - LANE_HEAD - LANE_PAD + GAP_Y) / (typical + GAP_Y)));
  const panels = order.map((k) => {
    const list = groups.get(k)!;
    // A wide board makes balanced blocks (4 cards: 2 × 2); a narrow one keeps panels one card wide
    // until they reach the board's height.
    const cols = view.w >= 1000 ? Math.max(Math.ceil(list.length / maxRows), Math.ceil(Math.sqrt(list.length))) : Math.ceil(list.length / maxRows);
    // Masonry: cards are dealt across the columns in order (newest first, reading across), and
    // each column stacks its own cards exactly one gap apart, whatever their heights.
    const place: { c: ChatSession; col: number; y: number }[] = [];
    const colY = Array.from({ length: cols }, () => 0);
    list.forEach((c, i) => {
      const col = i % cols;
      place.push({ c, col, y: colY[col] });
      colY[col] += hOf(c) + GAP_Y;
    });
    const w = cols * CARD_W + (cols - 1) * GAP_X;
    const h = Math.max(...colY) - GAP_Y;
    return { k, list, place, w, h };
  });
  const positions: Record<string, BoardPosition> = {};
  const lanes: Lane[] = [];
  // A wide board wraps panels at its own width. A narrow one keeps them in one strip, like lists
  // on a kanban board: every panel already fits its height, so it only ever scrolls sideways.
  const shelfW = view.w >= 1000 ? Math.max(view.w, ...panels.map((p) => p.w + 2 * LANE_PAD)) : Infinity;
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const p of panels) {
    const outerW = p.w + 2 * LANE_PAD;
    const outerH = p.h + LANE_HEAD + LANE_PAD;
    if (x > 0 && x + outerW > shelfW) {
      x = 0;
      y += shelfH + BETWEEN;
      shelfH = 0;
    }
    const ax = x + LANE_PAD;
    const ay = y + LANE_HEAD;
    for (const { c, col, y: cy } of p.place) positions[c.id] = { x: ax + col * (CARD_W + GAP_X), y: ay + cy };
    lanes.push({
      label: labelOf(p.k),
      folder: mode === "folder" ? p.k : undefined,
      here: mode === "folder" && p.k === root,
      count: p.list.length,
      latest: Math.max(...p.list.map((c) => c.lastModified)),
      x: ax,
      y: ay,
      w: p.w,
      h: p.h,
    });
    x += outerW + BETWEEN;
    shelfH = Math.max(shelfH, outerH);
  }
  return { positions, lanes };
}

/**
 * Cards pushed down, never up, until each is one unit clear of every card above it that it shares
 * any width with. Cards side by side are left alone. Only the cards that move are returned.
 */
export function spreadDown(cards: { id: string; x: number; y: number; w: number; h: number }[]): Record<string, BoardPosition> {
  const order = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const moved: Record<string, BoardPosition> = {};
  for (const c of order) {
    let y = c.y;
    for (let pass = 0; pass < order.length; pass++) {
      const under = placed.filter((p) => c.x < p.x + p.w && c.x + c.w > p.x && y < p.y + p.h + UNIT && y + c.h + UNIT > p.y);
      if (!under.length) break;
      y = Math.max(...under.map((p) => p.y + p.h + UNIT));
    }
    placed.push({ x: c.x, y, w: c.w, h: c.h });
    if (Math.abs(y - c.y) > 0.5) moved[c.id] = { x: c.x, y };
  }
  return moved;
}

/**
 * Where a dropped card goes: where it was dropped, unless that is closer than one unit to another
 * card; then the nearest place beside that card (below, above, right or left) that is one unit clear
 * of every card. A few steps at most; a crowded spot ends at the last clear place found.
 */
export function clearOf(pos: BoardPosition, size: { w: number; h: number }, others: { x: number; y: number; w: number; h: number }[]): BoardPosition {
  const tooClose = (p: BoardPosition) =>
    others.find((o) => p.x < o.x + o.w + UNIT && p.x + size.w + UNIT > o.x && p.y < o.y + o.h + UNIT && p.y + size.h + UNIT > o.y);
  // Nearly lined up with a card (within half a unit) is meant to be lined up.
  const near = (v: number, list: number[]) => list.find((t) => Math.abs(v - t) <= UNIT / 2) ?? v;
  let p = { x: near(pos.x, others.map((o) => o.x)), y: near(pos.y, others.map((o) => o.y)) };
  for (let step = 0; step < 24; step++) {
    const hit = tooClose(p);
    if (!hit) return p;
    // Placed under or beside the card it came near, lined up with that card's edge when it was
    // nearly lined up anyway (within a unit), so neat columns stay neat.
    const ax = Math.abs(p.x - hit.x) < UNIT ? hit.x : p.x;
    const ay = Math.abs(p.y - hit.y) < UNIT ? hit.y : p.y;
    const options = [
      { x: ax, y: hit.y + hit.h + UNIT },
      { x: ax, y: hit.y - size.h - UNIT },
      { x: hit.x + hit.w + UNIT, y: ay },
      { x: hit.x - size.w - UNIT, y: ay },
    ];
    const free = options.filter((o) => !tooClose(o));
    const pick = (free.length ? free : options).sort((a, b) => Math.hypot(a.x - pos.x, a.y - pos.y) - Math.hypot(b.x - pos.x, b.y - pos.y))[0];
    p = pick;
  }
  return p;
}

/**
 * Lays cards out by who shares with whom: chats that only share sit on the
 * left, each chat one column right of what feeds it, columns centred on each
 * other; unlinked chats go below in an even grid. Uses each card's real size.
 */
export function autoLayout(ids: string[], conns: ConnectionView[], sizes: Record<string, { w: number; h: number }> = {}): Record<string, BoardPosition> {
  const size = (id: string) => sizes[id] ?? { w: CARD_W, h: CARD_H };
  const set = new Set(ids);
  const edges = conns.filter((c) => set.has(c.from.id) && set.has(c.to.id) && c.from.id !== c.to.id);
  const linked = new Set(edges.flatMap((e) => [e.from.id, e.to.id]));
  const rank = new Map<string, number>();
  for (const id of linked) rank.set(id, 0);
  for (let pass = 0; pass < linked.size; pass++) {
    let changed = false;
    for (const e of edges) {
      const r = (rank.get(e.from.id) ?? 0) + 1;
      if (r > (rank.get(e.to.id) ?? 0) && r < linked.size) {
        rank.set(e.to.id, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const out: Record<string, BoardPosition> = {};
  const cols = new Map<number, string[]>();
  for (const id of ids) if (linked.has(id)) cols.set(rank.get(id)!, [...(cols.get(rank.get(id)!) ?? []), id]);
  const colHeight = (list: string[]) => list.reduce((h, id) => h + size(id).h, 0) + ROW_GAP * (list.length - 1);
  const tallest = Math.max(0, ...[...cols.values()].map(colHeight));
  let x = 0;
  for (const col of [...cols.keys()].sort((a, b) => a - b)) {
    const list = cols.get(col)!;
    let y = (tallest - colHeight(list)) / 2;
    const width = Math.max(...list.map((id) => size(id).w));
    for (const id of list) {
      out[id] = { x, y };
      y += size(id).h + ROW_GAP;
    }
    x += width + COL_GAP;
  }
  const loose = ids.filter((id) => !linked.has(id));
  const perRow = Math.max(3, Math.min(4, Math.ceil(Math.sqrt(loose.length))));
  let y = linked.size ? tallest + 96 : 0;
  for (let i = 0; i < loose.length; i += perRow) {
    const row = loose.slice(i, i + perRow);
    row.forEach((id, j) => (out[id] = { x: j * (CARD_W + LOOSE_GAP), y }));
    y += Math.max(...row.map((id) => size(id).h)) + ROW_GAP;
  }
  return out;
}
