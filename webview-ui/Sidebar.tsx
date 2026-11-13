// The sidebar: every AI chat in this folder, grouped by what needs attention.
// "All folders" shows the chats of every project instead, grouped by folder; a
// chat from another folder that is linked to one here always shows, labelled.
// Kept simple on purpose: the tool's logo, the title, one quiet line saying
// what is going on, and actions on hover. Tokens live on the Fuel page.
//
// Linking: press a row's link icon and click the chats it should share with
// (or drag one row onto another). No dialogs: the link works at once.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type HTMLAttributes } from "react";
import type { ConnectionView, ViewState } from "../src/core/protocol";
import type { ChatSession, Tool } from "../src/core/types";
import { DRAG_TYPE, agoText, contextPct, folderName, modelName, remember, remembered, send, whereItOpens } from "./api";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronRight,
  GitBranch,
  I,
  Inbox,
  LayoutGrid,
  Link2,
  Eye,
  Folder,
  FolderOpen,
  FolderTree,
  FolderX,
  ListFilter,
  MessageSquareDot,
  SearchX,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  ToolMark,
  Unlink,
  X,
  Zap,
} from "./Icons";
import type { Modal } from "./Modals";
import { CompactButton, ModelPicker } from "./ChatControls";
import { PlanStrip } from "./Plans";

type GroupKey = "needs" | "working" | "today" | "week" | "older";
const GROUP_LABEL: Record<GroupKey, string> = { needs: "Needs you", working: "Working", today: "Today", week: "This week", older: "Older" };
type Scope = "here" | "all";
interface Group {
  key: string;
  label: string;
  items: ChatSession[];
  /** A folder's own group: its rows need no folder label. */
  folder?: string;
  /** Its parent folder's name, when another folder has the same name. */
  hint?: string;
  waiting?: number;
  working?: number;
  /** When anything in the folder last happened. */
  latest?: number;
  /** The agents that have chats in it. */
  tools?: Tool[];
}
const OLDER_STEP = 15;

export function Sidebar({ state, setModal }: { state: ViewState; setModal: (m: Modal) => void }) {
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<Tool | "All">(remembered("tool", "All"));
  const [folded, setFolded] = useState<Record<string, boolean>>(remembered("folded", { older: true }));
  const [olderShown, setOlderShown] = useState(OLDER_STEP);
  const [linking, setLinking] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [scope, setScopeState] = useState<Scope>(remembered("scope", "here"));
  // Folders left out of "All folders" (new folders show by default).
  const [hidden, setHiddenState] = useState<string[]>(remembered("hiddenFolders", []));
  const setHidden = (v: string[]) => {
    setHiddenState(v);
    remember("hiddenFolders", v);
  };
  const setScope = (v: Scope) => {
    setScopeState(v);
    remember("scope", v);
    // The board follows: every folder → By folder, this folder → By links.
    send({ type: "scope", scope: v });
  };

  const outgoing = useMemo(() => groupBy(state.connections, (c) => c.from.id), [state.connections]);
  const incoming = useMemo(() => groupBy(state.connections, (c) => c.to.id), [state.connections]);

  const linkedIds = useMemo(() => new Set(state.connections.flatMap((c) => [c.from.id, c.to.id])), [state.connections]);
  const hasElsewhere = useMemo(() => state.sessions.some((s) => s.away), [state.sessions]);
  // Picking chats to link looks in every folder.
  // Picking chats to link has its own view of the folders: it starts on every folder (any chat can
  // be linked) and can be narrowed with the same tabs, folder filter, search and agent chips.
  const [linkScope, setLinkScope] = useState<Scope>("all");
  useEffect(() => {
    if (linking) {
      setLinkScope("all");
      setQuery("");
    }
  }, [linking]);
  const activeScope = linking ? linkScope : scope;
  const everyFolder = activeScope === "all" && hasElsewhere;
  const folderOf = (s: ChatSession) => (s.away ? s.cwd : state.root) ?? state.root ?? "";
  const folders = useMemo(() => folderList(state.sessions, state.root), [state.sessions, state.root]);
  const nothingPicked = everyFolder && folders.length > 0 && folders.every((f) => hidden.includes(f.path));
  const pool = useMemo(() => {
    if (everyFolder) return state.sessions.filter((s) => !hidden.includes(folderOf(s)) || s.id === linking);
    return state.sessions.filter((s) => !s.away || linkedIds.has(s.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everyFolder, linking, state.sessions, linkedIds, hidden, state.root]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (s: ChatSession) => s.title.toLowerCase().includes(q) || (s.branch ?? "").toLowerCase().includes(q) || folderName(s.cwd).toLowerCase().includes(q);
    return pool.filter((s) => (tool === "All" || s.tool === tool) && (!q || hit(s)));
  }, [pool, query, tool]);
  const groups = useMemo(() => (everyFolder ? groupByFolder(visible, state.root) : groupChats(visible)), [visible, everyFolder, state.root]);
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef);
  const manyTools = useMemo(() => new Set(state.sessions.map((x) => x.tool)).size > 1, [state.sessions]);
  const linkSource = linking ? state.sessions.find((s) => s.id === linking) : undefined;

  const connectionBetween = (from: string, to: string) => outgoing.get(from)?.find((c) => c.to.id === to);
  // Ticks show at once; the real state replaces them when the extension answers.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  useEffect(() => setOptimistic({}), [state.connections]);
  const isLinked = (to: string) => (linking ? (optimistic[to] ?? !!connectionBetween(linking, to)) : false);
  const toggleLink = (to: string) => {
    if (!linking || linking === to) return;
    const existing = connectionBetween(linking, to);
    const now = isLinked(to);
    setOptimistic((o) => ({ ...o, [to]: !now }));
    if (now && existing) send({ type: "disconnect", connectionId: existing.id });
    else if (!now) send({ type: "connect", from: linking, to });
  };
  const setToolFilter = (t: Tool | "All") => {
    setTool(t);
    remember("tool", t);
  };
  // A folder starts closed unless it is this one or something in it needs you or is working; a
  // heading the person opened or closed stays that way.
  const isFoldedGroup = (g: Group) => (g.key in folded ? folded[g.key] : !!g.folder && g.folder !== state.root && !g.waiting && !g.working);
  const fold = (g: string) => {
    const group = groups.find((x) => x.key === g);
    const next = { ...folded, [g]: !(group ? isFoldedGroup(group) : folded[g]) };
    setFolded(next);
    remember("folded", next);
  };

  const rowProps = (s: ChatSession, g: Group): RowProps => ({
    s,
    nested: !!g.folder,
    showFolder: !!s.away && !g.folder,
    links: mergeLinks(outgoing.get(s.id) ?? [], incoming.get(s.id) ?? []),
    manyTools,
    waiting: state.inbox[s.id]?.count,
    waitingFrom: state.inbox[s.id]?.from,
    expanded: expanded === s.id,
    linking,
    linked: isLinked(s.id),
    dropTarget: over === s.id && !!dragging && dragging !== s.id,
    isDragging: dragging === s.id,
    onToggleExpand: () => setExpanded(expanded === s.id ? null : s.id),
    onLink: () => {
      setExpanded(null);
      setLinking(linking === s.id ? null : s.id);
    },
    onPickLink: () => toggleLink(s.id),
    onBranch: () => {
      setModal({ kind: "loading", label: "Reading the chat…" });
      send({ type: "askBranch", id: s.id });
    },
    onPeek: () => send({ type: "peek", id: s.id }),
    drag: {
      draggable: !linking,
      onDragStart: (e: ReactDragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "link";
        setDragging(s.id);
      },
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
      onDragOver: (e: ReactDragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE) || dragging === s.id) return;
        e.preventDefault();
        if (over !== s.id) setOver(s.id);
      },
      onDragLeave: () => over === s.id && setOver(null),
      onDrop: (e: ReactDragEvent) => {
        e.preventDefault();
        const from = e.dataTransfer.getData(DRAG_TYPE);
        setOver(null);
        setDragging(null);
        if (from && from !== s.id) send({ type: "connect", from, to: s.id });
      },
    },
  });

  return (
    <div className="sidebar">
      {linkSource ? (
        <div className="linkbar" role="status">
          <ToolMark tool={linkSource.tool} size={16} />
          <span className="grow">
            <span className="linkbarhint">Pick chats to connect</span>
            <strong className="ellipsis block">{linkSource.title}</strong>
          </span>
          <button className="btn small primary" onClick={() => setLinking(null)}>
            Done
          </button>
        </div>
      ) : (
        !state.loading &&
        !state.hooksOn &&
        state.root && (
          <div className="banner">
            <Zap {...I} size={16} className="bannericon" />
            <span>Turn on auto-sharing so connected chats keep each other up to date.</span>
            <button className="btn small primary" onClick={() => send({ type: "setup" })}>
              Turn on
            </button>
          </div>
        )
      )}
      <>
          {hasElsewhere && (
            <div className="scopebar">
            <div className="scope" role="group" aria-label="Which chats to show">
              {/* Short, fixed words that never get cut off; the folder's own name is in the hint. */}
              <button className={activeScope === "here" ? "on" : ""} aria-pressed={activeScope === "here"} onClick={() => (linking ? setLinkScope("here") : setScope("here"))} data-tip={folderName(state.root) ? `Chats in ${folderName(state.root)}` : undefined}>
                <FolderOpen {...I} size={13} />
                <span className="ellipsis">This folder</span>
              </button>
              <button className={activeScope === "all" ? "on" : ""} aria-pressed={activeScope === "all"} onClick={() => (linking ? setLinkScope("all") : setScope("all"))} data-tip={`Chats in all ${folders.length} folders`}>
                <FolderTree {...I} size={13} />
                <span className="ellipsis">All</span>
                <span className="scopecount">{folders.length}</span>
              </button>
            </div>
            {everyFolder && folders.length > 1 && <FolderPicker folders={folders} hidden={hidden} setHidden={setHidden} root={state.root} />}
            </div>
          )}
          <div className="searchrow">
            <Search {...I} className="muted" />
            <input className="search" placeholder={`Search ${pool.length} chats`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />
            {query && (
              <button className="icon sm" aria-label="Clear search" onClick={() => setQuery("")}>
                <X {...I} />
              </button>
            )}
          </div>
          {state.tools.length > 1 && (
            <div className="chips" role="group" aria-label="Filter by tool">
              {(["All", ...state.tools] as (Tool | "All")[]).map((t) => (
                <button key={t} className={`chip ${tool === t ? "on" : ""}`} onClick={() => setToolFilter(t)}>
                  {t !== "All" && <ToolMark tool={t} size={12} />} {t}
                </button>
              ))}
            </div>
          )}
      </>

      {state.loading && <p className="hint pulse">Reading your chats…</p>}
      {state.error && <p className="banner warn">{state.error}</p>}

      {/* One continuous list: a chat moving between groups keeps its row (no rebuild, no replayed
          animations), and every row that moves slides to its new place. */}
      <div className="chatlist" ref={listRef}>
        {groups.flatMap((g) => {
          const { key, items } = g;
          // While linking, every folder is open so any chat can be picked.
          const isFolded = !query && !linking && isFoldedGroup(g);
          const shown = key === "older" && !query ? items.slice(0, olderShown) : items;
          const out = [
            <button
              key={`h:${key}`}
              data-flip={`h:${key}`}
              className={`grouphead ${g.folder ? "folder" : key}`}
              onClick={() => fold(key)}
              aria-expanded={!isFolded}
              data-tip={g.folder && g.folder !== state.root ? g.folder : undefined}
            >
              {g.folder ? (
                <>
                  <span className={`ftile ${g.folder === state.root ? "here" : ""}`} aria-label={g.folder === state.root ? "The folder open in this window" : undefined}>
                    {g.folder === state.root ? <FolderOpen {...I} size={15} /> : <Folder {...I} size={15} />}
                  </span>
                  <span className="fmain">
                    <span className="ftop">
                      <span className="fname ellipsis">{g.label}</span>
                      {g.hint && <span className="fhint ellipsis">{g.hint}</span>}
                    </span>
                    {/* Just when it was last active; the blue tile marks the folder open in this window. */}
                    <span className="fmeta">{g.latest ? agoText(g.latest) : ""}</span>
                  </span>
                  <span className="fside">
                    {(g.tools?.length ?? 0) > 1 && (
                      <span className="ftools" aria-label={`Chats from ${g.tools!.join(", ")}`}>
                        {g.tools!.map((t) => (
                          <span key={t} className="ftool">
                            <ToolMark tool={t} size={11} />
                          </span>
                        ))}
                      </span>
                    )}
                    {!!g.waiting && <span className="fdot waiting" aria-label={`${g.waiting} need you`} />}
                    {!!g.working && <span className="fdot working" aria-label={`${g.working} working`} />}
                    <span className="fcount" aria-label={`${items.length} chats`}>
                      {items.length}
                    </span>
                    <ChevronRight {...I} size={14} className={`chev fchev ${isFolded ? "" : "open"}`} />
                  </span>
                </>
              ) : (
                <>
                  <ChevronRight {...I} size={13} className={`chev ${isFolded ? "" : "open"}`} />
                  <span className="grow ellipsis">{g.label}</span>
                  <span className="count">{items.length}</span>
                </>
              )}
            </button>,
          ];
          if (!isFolded) for (const s of shown) out.push(<Row key={s.id} {...rowProps(s, g)} />);
          if (!isFolded && key === "older" && !query && items.length > olderShown)
            out.push(
              <button key="more" data-flip="more" className="linkish more" onClick={() => setOlderShown((n) => n + OLDER_STEP)}>
                Show {Math.min(OLDER_STEP, items.length - olderShown)} more
              </button>,
            );
          return out;
        })}
      </div>

      {!state.loading && !state.error && visible.length === 0 && (
        <EmptyState
          kind={nothingPicked ? "picked" : pool.length ? "search" : "none"}
          query={query.trim()}
          tool={tool}
          folder={folderName(state.root)}
          tools={state.tools.length ? state.tools : ["Claude"]}
          canSeeAll={!everyFolder && hasElsewhere}
          showAll={() => setHidden([])}
          clearSearch={() => {
            setQuery("");
            setToolFilter("All");
          }}
          seeAll={() => setScope("all")}
        />
      )}
      <PlanStrip state={state} />
    </div>
  );
}

interface MergedLink {
  other: ConnectionView["from"];
  /** This chat shares its work with the other. */
  shares?: ConnectionView;
  /** This chat learns from the other. */
  learns?: ConnectionView;
}

/** One entry per linked chat, whichever way the work flows. */
function mergeLinks(out: ConnectionView[], inc: ConnectionView[]): MergedLink[] {
  const by = new Map<string, MergedLink>();
  for (const c of out) by.set(c.to.id, { ...(by.get(c.to.id) ?? { other: c.to }), shares: c });
  for (const c of inc) by.set(c.from.id, { ...(by.get(c.from.id) ?? { other: c.from }), learns: c });
  return [...by.values()];
}

interface RowProps {
  /** Shown inside a folder's group: drawn under it, on its guide line. */
  nested?: boolean;
  /** The chat is from another folder, and its group doesn't already say which. */
  showFolder: boolean;
  /** More than one AI tool has chats here, so each row shows which. */
  manyTools: boolean;
  s: ChatSession;
  links: MergedLink[];
  waiting?: number;
  waitingFrom?: string[];
  expanded: boolean;
  linking: string | null;
  linked: boolean;
  dropTarget: boolean;
  isDragging: boolean;
  onToggleExpand: () => void;
  onLink: () => void;
  onPickLink: () => void;
  onBranch: () => void;
  onPeek: () => void;
  drag: HTMLAttributes<HTMLDivElement> & { draggable: boolean };
}

function Row(p: RowProps) {
  const { s } = p;
  const isSource = p.linking === s.id;
  const picking = !!p.linking && !isSource;
  const cls = ["row", s.status, `tool-${s.tool.toLowerCase()}`, p.expanded && "open", p.dropTarget && "drop", p.isDragging && "dragging", isSource && "source", picking && "picking", p.linked && "linked"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={`rowwrap ${p.nested ? "nested" : ""}`} data-flip={s.id}>
      <div className={cls} {...p.drag}>
        <button
          className="rowmain"
          onClick={() => (picking ? p.onPickLink() : send({ type: "open", id: s.id }))}
          data-tip={picking ? (p.linked ? "Click to disconnect" : "Click to connect") : s.title.length > 30 ? s.title : undefined}
        >
          <ChatAvatar s={s} showTool={p.manyTools} />
          <span className="rowtext">
            <span className="rowtop">
              <span className="rowtitle">{s.title}</span>
              {!!p.waiting && (
                <span className="unread" data-tip={`${p.waiting} update${p.waiting === 1 ? "" : "s"} from linked chats, arriving with its next message`}>
                  {p.waiting}
                </span>
              )}
            </span>
            <RowLine {...p} />
          </span>
        </button>
        {picking ? (
          <button
            className={`pickcheck ${p.linked ? "on" : ""}`}
            onClick={p.onPickLink}
            aria-pressed={p.linked}
            aria-label={p.linked ? `Disconnect “${s.title}”` : `Connect with “${s.title}”`}
          >
            {p.linked ? <Check {...I} size={12} strokeWidth={3} /> : <Plus {...I} size={12} />}
          </button>
        ) : isSource ? (
          <span className="sourcetag">Connecting</span>
        ) : (
          <span className="rowactions">
            {/* Open, the details below have Link to… and New task: the row keeps only its arrow. */}
            {!p.expanded && (
              <>
                <button className={`icon ${isSource ? "on" : ""}`} onClick={p.onLink} aria-label={`Connect “${s.title}” to other chats`} data-tip="Connect to other chats">
                  <Link2 {...I} />
                </button>
                <button className="icon" onClick={p.onBranch} aria-label={`New task from “${s.title}”`} data-tip="New task from this chat">
                  <GitBranch {...I} />
                </button>
              </>
            )}
            <button className="icon" onClick={p.onToggleExpand} aria-label="More" aria-expanded={p.expanded} data-tip="More">
              <ChevronRight {...I} className={`chev ${p.expanded ? "open" : ""}`} />
            </button>
          </span>
        )}
      </div>
      {p.expanded && !p.linking && <Details {...p} />}
    </div>
  );
}

/** One quiet line under the title: what the chat is doing, and who it is linked with. */
/** One line in words: what it is doing, its model and how full it is, and who it is linked with. */
function RowLine({ s, links, showFolder }: RowProps) {
  const pct = contextPct(s.context);
  if (s.status === "waiting") {
    return (
      <span className="rowmeta">
        <span className="state waiting">{s.lastLine || "Needs you"}</span>
        {showFolder && <FolderTag s={s} />}
      </span>
    );
  }
  const linkTip = `Linked with ${links.map((l) => l.other.title).join(", ")}`;
  return (
    <span className="rowmeta">
      {s.status === "working" ? <span className="state working">Working…</span> : <span>{agoText(s.lastModified)}</span>}
      {s.model && (
        <span className="mtext">
          {modelName(s.model)}
        </span>
      )}
      {pct !== undefined && s.context && (
        <span className={`ctxtag ${level(pct)}`} data-tip={`Context ${pct}% full: ${Math.round(s.context.used / 1000)}K of ${short(s.context.window)} tokens`}>
          <ContextRing pct={pct} />
          {pct}%<span className="ctxword"> context</span>
        </span>
      )}
      {showFolder && <FolderTag s={s} />}
      {links.length > 0 && (
        <span className="linkedtag" data-tip={linkTip}>
          <Link2 {...I} size={11} />
          <span className="ltext">{links.length === 1 ? links[0].other.title : `${links.length} chats`}</span>
          <span className="lcount">{links.length}</span>
        </span>
      )}
    </span>
  );
}

/** Which folder a chat from elsewhere works in (its full path on hover). */
function FolderTag({ s }: { s: ChatSession }) {
  return (
    <span className="foldertag" data-tip={s.cwd}>
      <Folder {...I} size={11} />
      <span className="ellipsis">{folderName(s.cwd)}</span>
    </span>
  );
}

/** The agent's own logo in a tile tinted with its colour; the tile's ring shows the status. */
function ChatAvatar({ s }: { s: ChatSession; showTool?: boolean }) {
  return (
    <span className={`avatar tool-${s.tool.toLowerCase()} ${s.status}`} aria-hidden="true">
      <ToolMark tool={s.tool} size={16} />
    </span>
  );
}

/** A small ring that fills as the context window does. */
function ContextRing({ pct }: { pct: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${level(pct)}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r={r} className="ringbg" />
      <circle cx="6" cy="6" r={r} className="ringfg" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 6 6)" />
    </svg>
  );
}

function level(pct: number): string {
  return pct >= 90 ? "full" : pct >= 70 ? "high" : "ok";
}

function Details({ s, links, waiting, waitingFrom, onPeek, onLink, onBranch }: RowProps) {
  const pct = contextPct(s.context);
  return (
    <div className="details">
      {(s.model || s.context || s.away) && (
        <div className="facts">
          {s.away && (
            <div className="fact">
              <span className="muted">Folder</span>
              <span className="ellipsis" data-tip={s.cwd}>
                {folderName(s.cwd)}
              </span>
            </div>
          )}
          {s.model && (
            <div className="fact">
              <span className="muted">Model</span>
              <ModelPicker s={s} />
            </div>
          )}
          {s.context && pct !== undefined && (
            <div className="fact">
              <span className="muted">Context</span>
              <span className="ctx" data-tip={`${s.context.used.toLocaleString()} of ${s.context.window.toLocaleString()} tokens`}>
                <span className={`ctxbar ${level(pct)}`}>
                  <span style={{ width: `${Math.max(2, pct)}%` }} />
                </span>
                {pct}%<span className="ofwin"> of {short(s.context.window)}</span>
              </span>
              <CompactButton s={s} />
            </div>
          )}
        </div>
      )}
      {links.length ? (
        <div className="detailblock">
          <div className="detailhead">Channels</div>
          <div className="linklist">
            {links.map((l) => (
              <LinkRow key={l.other.id} l={l} />
            ))}
          </div>
        </div>
      ) : (
        <p className="explain">Open a channel to another chat and each keeps up with what the other did, after every reply.</p>
      )}
      {!!waiting && (
        <div className="incoming nodrag">
          <div className="inhead">
            <span className="inicon" aria-hidden="true">
              <MessageSquareDot {...I} size={15} />
            </span>
            <span className="intext">
              <b>
                {waiting} update{waiting === 1 ? "" : "s"} on the way
              </b>
              <span className="insub">from {waitingFrom?.join(", ") || "linked chats"}</span>
            </span>
          </div>
          <div className="inactions">
            <button className="btn tiny ghost" onClick={onPeek}>
              <Eye {...I} size={12} /> View
            </button>
            <button className="btn tiny primary" onClick={() => send({ type: "syncNow", id: s.id })} data-tip="They arrive by themselves when the chat replies or gets its next message. Sync sends them now.">
              <RefreshCw {...I} size={12} /> Sync
            </button>
          </div>
        </div>
      )}
      <div className="detailactions">
        <button className="btn small" onClick={onLink} data-tip="Pick chats to share work with">
          <Link2 {...I} /> <span className="blabel">Connect…</span>
        </button>
        <button className="btn small" onClick={onBranch} data-tip="Start a new chat for a separate task, with this chat's context">
          <GitBranch {...I} /> <span className="blabel">New task</span>
        </button>
        <span className="grow" />
        {/* This folder's chat opens in Claude's panel, so the extra way is a terminal. Another
            folder's chat already opens in a terminal, so the extra way is its own folder's window. */}
        {s.away ? (
          <button
            className="icon openfolder"
            onClick={() => send({ type: "openInFolder", id: s.id })}
            data-tip={`Open in ${folderName(s.cwd)}: its own window, ${whereItOpens(s.tool)}`}
            aria-label={`Open this chat in ${folderName(s.cwd)}`}
          >
            <FolderOpen {...I} />
          </button>
        ) : (
          <button className="icon" onClick={() => send({ type: "openInTerminal", id: s.id })} aria-label="Open in terminal" data-tip="Open in terminal">
            <SquareTerminal {...I} />
          </button>
        )}
        <button className="icon" onClick={() => send({ type: "boardAdd", id: s.id, open: true })} aria-label="Show on Tower" data-tip="Show on Tower">
          <LayoutGrid {...I} />
        </button>
      </div>
    </div>
  );
}

function LinkRow({ l }: { l: MergedLink }) {
  const both = !!(l.shares && l.learns);
  const conns = [l.shares, l.learns].filter((c): c is ConnectionView => !!c);
  const paused = conns.every((c) => c.paused);
  const how = both ? "both ways" : l.shares ? "shares with it" : "learns from it";
  const DirIcon = both ? ArrowLeftRight : l.shares ? ArrowRight : ArrowLeft;
  return (
    <div className={`linkrow ${paused ? "paused" : ""}`}>
      <ToolMark tool={l.other.tool} size={18} />
      <span className="linkname">
        <span className="ellipsis">{l.other.title}</span>
        <span className={`linkhow ${both ? "both" : l.shares ? "out" : "in"}`}>
          <DirIcon {...I} size={11} /> {paused ? "paused" : how}
        </span>
      </span>
      <span className="linkbtns">
        <button
          className="icon sm"
          onClick={() => conns.forEach((c) => send({ type: "pause", connectionId: c.id, paused: !paused }))}
          aria-label={paused ? `Resume sharing with “${l.other.title}”` : `Pause sharing with “${l.other.title}”`}
          data-tip={paused ? "Resume sharing" : "Pause sharing"}
        >
          {paused ? <Play {...I} size={13} /> : <Pause {...I} size={13} />}
        </button>
        <button className="icon sm" onClick={() => send({ type: "disconnectMany", ids: conns.map((c) => c.id) })} aria-label={`Close the channel with “${l.other.title}”`} data-tip="Close channel">
          <Unlink {...I} size={13} />
        </button>
      </span>
    </div>
  );
}

function short(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
}

function groupChats(list: ChatSession[]): Group[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = startOfToday - 6 * 86_400_000;
  const out: Record<GroupKey, ChatSession[]> = { needs: [], working: [], today: [], week: [], older: [] };
  for (const s of list) {
    if (s.status === "waiting") out.needs.push(s);
    else if (s.status === "working") out.working.push(s);
    else if (s.lastModified >= startOfToday) out.today.push(s);
    else if (s.lastModified >= weekAgo) out.week.push(s);
    else out.older.push(s);
  }
  return (Object.keys(out) as GroupKey[]).filter((k) => out[k].length).map((key) => ({ key, label: GROUP_LABEL[key], items: out[key] }));
}

/** Rows inside a folder: what needs you, then what is working, then the newest. */
const ORDER: Record<string, number> = { waiting: 0, working: 1 };

/**
 * One group per folder, this window's folder first, the rest by their newest chat. A folder
 * whose name another folder shares says its parent ("work · e2e2").
 */
function groupByFolder(list: ChatSession[], root?: string): Group[] {
  const folders = new Map<string, ChatSession[]>();
  for (const s of list) {
    const f = (s.away ? s.cwd : root) ?? root ?? "";
    folders.set(f, [...(folders.get(f) ?? []), s]);
  }
  const newest = (f: string) => Math.max(...folders.get(f)!.map((s) => s.lastModified));
  const order = [...folders.keys()].sort((a, b) => (a === root ? -1 : b === root ? 1 : newest(b) - newest(a)));
  const names = new Map<string, number>();
  for (const f of order) names.set(folderName(f), (names.get(folderName(f)) ?? 0) + 1);
  return order.map((f) => {
    const items = [...folders.get(f)!].sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2) || b.lastModified - a.lastModified);
    return {
      key: `f:${f}`,
      label: folderName(f) || "Other",
      items,
      folder: f,
      hint: (names.get(folderName(f)) ?? 0) > 1 ? folderName(f.replace(/[\\/][^\\/]+[\\/]?$/, "")) : undefined,
      waiting: items.filter((s) => s.status === "waiting").length,
      working: items.filter((s) => s.status === "working").length,
      latest: newest(f),
      tools: [...new Set(items.map((s) => s.tool))],
    };
  });
}

interface FolderInfo {
  path: string;
  name: string;
  hint?: string;
  count: number;
  latest?: number;
}

/** Every folder with chats, this one first, then by their newest chat. */
function folderList(sessions: ChatSession[], root?: string): FolderInfo[] {
  return groupByFolder(sessions, root).map((g) => ({ path: g.folder!, name: g.label, hint: g.hint, count: g.items.length, latest: g.latest }));
}

/**
 * Which folders "All folders" shows: a filter button at the end of the tabs, opening a list
 * over the chats (it never pushes them down). Built for many folders: a search that is ready to
 * type, the newest first with when each was last active, a scrolling list, and quick choices.
 * Every tick applies at once; a click outside or Esc closes it.
 */
function FolderPicker({ folders, hidden, setHidden, root }: { folders: FolderInfo[]; hidden: string[]; setHidden: (v: string[]) => void; root?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const shown = folders.filter((f) => !hidden.includes(f.path)).length;
  const needle = q.trim().toLowerCase();
  // By the folder's name (or the parent that tells two same-named folders apart).
  const list = folders.filter((f) => !needle || f.name.toLowerCase().includes(needle) || (f.hint ?? "").toLowerCase().includes(needle));
  const toggle = (p: string) => setHidden(hidden.includes(p) ? hidden.filter((x) => x !== p) : [...hidden, p]);
  const allOn = shown === folders.length;
  const onlyHere = !!root && shown === 1 && !hidden.includes(root);
  const none = shown === 0;
  return (
    <div className="fpicker" ref={ref}>
      <button
        className={`ffilter ${allOn ? "" : "some"} ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={allOn ? "Choose folders" : `Showing ${shown} of ${folders.length} folders`}
      >
        <ListFilter {...I} size={14} />
        {!allOn && (
          <span className="ffcount">
            {shown}/{folders.length}
          </span>
        )}
      </button>
      {open && (
        <div className="fpop" role="dialog" aria-label="Folders to show">
          <div className="fpophead">
            <span className="fpoptitle">Show folders</span>
            <div className="fquick" role="group" aria-label="Quick choice">
              <button className={allOn ? "on" : ""} aria-pressed={allOn} onClick={() => setHidden([])}>
                All
              </button>
              {root && (
                <button className={onlyHere ? "on" : ""} aria-pressed={onlyHere} onClick={() => setHidden(folders.map((f) => f.path).filter((p) => p !== root))}>
                  Current only
                </button>
              )}
              <button className={none ? "on" : ""} aria-pressed={none} onClick={() => setHidden(folders.map((f) => f.path))}>
                None
              </button>
            </div>
          </div>
          <div className="searchrow fsearch">
            <Search {...I} className="muted" size={13} />
            <input autoFocus className="search" placeholder={`Find among ${folders.length} folders`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a folder" />
            {q && (
              <button className="icon sm" aria-label="Clear" onClick={() => setQ("")}>
                <X {...I} size={12} />
              </button>
            )}
          </div>
          <div className="flist">
            {list.map((f) => {
              const on = !hidden.includes(f.path);
              const here = f.path === root;
              return (
                <label key={f.path} className={`fitem ${on ? "on" : ""}`} data-tip={f.path}>
                  <input type="checkbox" checked={on} onChange={() => toggle(f.path)} />
                  <span className="fcheck" aria-hidden="true">
                    {on && <Check {...I} size={11} strokeWidth={3} />}
                  </span>
                  {here ? <FolderOpen {...I} size={13} className="fitemicon here" /> : <Folder {...I} size={13} className="fitemicon" />}
                  <span className="fitemtext">
                    <span className="fitemname">
                      <span className="fname ellipsis">{f.name}</span>
                      {f.hint && <span className="fhint ellipsis">{f.hint}</span>}
                    </span>
                    <span className="fitemmeta">{f.latest ? agoText(f.latest) : ""}</span>
                  </span>
                  <span className="count">{f.count}</span>
                </label>
              );
            })}
            {!list.length && <p className="muted small fnone">No folder matches “{q.trim()}”.</p>}
          </div>
          <div className="fpopfoot">
            <span className="muted">
              {shown} of {folders.length} shown
            </span>
            <span className="grow" />
            {!allOn && (
              <button className="linkish" onClick={() => setHidden([])}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** What the list shows when it has nothing: says why, and offers the one step that helps. */
function EmptyState(p: {
  kind: "picked" | "search" | "none";
  query: string;
  tool: Tool | "All";
  folder: string;
  tools: Tool[];
  canSeeAll: boolean;
  showAll: () => void;
  clearSearch: () => void;
  seeAll: () => void;
}) {
  if (p.kind === "picked")
    return (
      <div className="emptystate">
        <span className="emptyicon">
          <FolderX {...I} size={20} />
        </span>
        <p className="emptytitle">No folders picked</p>
        <p className="emptytext">Tick the folders to show, or show them all.</p>
        <div className="emptyactions">
          <button className="btn primary" onClick={p.showAll}>
            <FolderTree {...I} size={13} /> Show all folders
          </button>
        </div>
      </div>
    );
  if (p.kind === "search")
    return (
      <div className="emptystate">
        <span className="emptyicon">
          <SearchX {...I} size={20} />
        </span>
        <p className="emptytitle">{p.query ? `Nothing matches “${p.query}”` : `No ${p.tool} chats here`}</p>
        <p className="emptytext">{p.query ? "Try another word, or a folder's name." : "Other agents' chats are under All."}</p>
        <div className="emptyactions">
          <button className="btn" onClick={p.clearSearch}>
            <X {...I} size={13} /> {p.query ? "Clear search" : "Show every agent"}
          </button>
        </div>
      </div>
    );
  return (
    <div className="emptystate">
      <span className="emptyicon">
        <MessageSquareDot {...I} size={20} />
      </span>
      <p className="emptytitle">No chats here yet</p>
      <p className="emptytext">Start one in {p.folder || "this folder"}. Crosstalk picks it up by itself.</p>
      <div className="emptyactions">
        {p.tools.map((t, i) => (
          <button key={t} className={`btn ${i === 0 ? "primary" : ""}`} onClick={() => send({ type: "newChat", tool: t })}>
            <ToolMark tool={t} size={13} /> New {t} chat
          </button>
        ))}
      </div>
      {p.canSeeAll && (
        <button className="linkish emptymore" onClick={p.seeAll}>
          <FolderTree {...I} size={12} /> See chats in your other folders
        </button>
      )}
    </div>
  );
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/**
 * Slides rows to their new place when the list reorders (a chat moving from
 * Working to Today, say), instead of letting them jump. Positions are measured
 * inside the list, so scrolling never sets anything moving.
 */
function useFlip(ref: React.RefObject<HTMLDivElement | null>): void {
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const next = new Map<string, number>();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const id = el.dataset.flip!;
      const top = el.offsetTop;
      next.set(id, top);
      const before = prev.current.get(id);
      if (reduce || before === undefined || Math.abs(before - top) < 2) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${before - top}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform .32s cubic-bezier(.2, .8, .2, 1)";
        el.style.transform = "";
      });
    });
    prev.current = next;
  });
}
