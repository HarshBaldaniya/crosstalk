// The extension's centre: keeps the list of chats (from every tool) current,
// answers the webviews, and turns their requests (connect, branch, open) into
// connections, context and chats.
import * as vscode from "vscode";
import { agentStates, installToolkit, refreshCodexPrompts, removeToolkit } from "../core/toolkit";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import type { Adapter } from "../adapters/adapter";
import { ClaudeAdapter } from "../adapters/claude";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CodexAdapter } from "../adapters/codex";
import { GeminiAdapter } from "../adapters/gemini";
import { claudeProjectFolder, claudeProjectsDir, codexSessionsDir, readJson, crosstalkFile, crosstalkHome, statusDir } from "../core/paths";
import type { BoardTab, ConnectionView, FromWebview, ModelOption, ToWebview, ToolTotals, ViewState } from "../core/protocol";
import { CodeMap } from "../codemap/index";
import { codeHits, codeMapView, codeModuleView, knownProjects, libraryView } from "./pages";
import type { RunsService } from "./runs-service";
import { allCommands, STARTER_DESCRIPTION, userLibraryDir } from "../library/index";

/** Folders picked with "Map another folder", newest first. */
const MAPPED_FOLDERS = "crosstalk.mappedFolders";
import { BoardStore } from "../core/state";
import { readHookStatus, resolveStatus } from "../core/status";
import {
  addConnection,
  addPending,
  appendInbox,
  getCursor,
  logDelivery,
  readConnections,
  readDeliveries,
  readInbox,
  removeConnection,
  setCursor,
  setPaused,
  takeInbox,
  setLevel,
} from "../core/store";
import { addUsage } from "../core/transcript";
import type { ChatDigest, ChatRef, ChatSession, Connection, PlanUsage, Status, Tool } from "../core/types";
import { NO_USAGE } from "../core/types";
import { addOpenRequest, dropOpenRequest, openRequestWaiting, isTempFolder, pickElsewhere, takeOpenRequests } from "../core/folders";
import { claudePlanFrom, codexPlanFrom, geminiPlan, type ClaudeUsageAnswer } from "../core/plans";
import { recentRollouts } from "../adapters/codex";
import { readTail } from "../core/transcript";
import { CONTEXT_BUDGET, buildContext, buildUpdate, formatDelivery, oldConversationsDir, sameFolder, type ContextSize } from "../core/updates";
import { HOOK_START_MAX, HOOK_STEP_MAX, catchUpRecord, pruneRecords, readHead, recordBehind, readAsks, readAsksFrom, recordContext, recordPointer, renderAsks, setRecordTitle, toolOf, type LinkLevel } from "../core/record";
import { workspaceCrosstalkPath, writeFileAtomic } from "../core/paths";
import { moveOldHome, moveOldWorkspace } from "../core/migrate";
import { connect, disconnect, findClaude, findNode, hookCommandFor, hookTargets, installedHookPath, isConnected, isToolConnected, staleHookTargets } from "../core/hooks";
import { claudeExtensionInstalled, openClaude, openInTerminal, ownTerminalFor, typeWhenStarted } from "./open";
import { webviewHtml } from "./webview-html";

const POLL_MS = 10_000;
const PER_TOOL = 60;
/** Chats from every folder: read again at most every 30 s (see pickElsewhere for which are shown). */
const ELSEWHERE_PER_TOOL = 400;
const ELSEWHERE_MS = 30_000;
/** Plan limits are read again at most this often (a Refresh on the Fuel page reads them at once). */
const PLANS_MS = 5 * 60_000;
/**
 * A chat file with more than this not yet counted is counted in the background, a slice at a time,
 * so the list shows at once and the extension never stops answering (one chat file can be a gigabyte).
 */
const QUICK_BYTES = 2 * 1024 * 1024;
const SLICE_BYTES = 4 * 1024 * 1024;
/**
 * "Open in its folder": how long the other window's Crosstalk gets to take the request once that window
 * is in front (it takes it at once when current), and the most Crosstalk waits for a window to appear.
 */
const OPEN_ANSWER_MS = 700;
const OPEN_GIVE_UP_MS = 10_000;
/** A non-Claude chat quiet this long has finished its reply: its update can go out. */
const QUIET_MS = 15_000;

export class Controller implements vscode.Disposable {
  private readonly adapters: Adapter[] = [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()];
  private readonly views = new Set<vscode.Webview>();
  private board: vscode.WebviewPanel | undefined;
  private state: ViewState = {
    tools: [],
    sessions: [],
    connections: [],
    inbox: {},
    board: { members: [], positions: {} },
    totals: {},
    hooksOn: false,
    claudeExtension: false,
    loading: true,
  };
  private byId = new Map<string, ChatSession>();
  private readonly lastStatus = new Map<string, Status>();
  private readonly digests = new Map<string, ChatDigest>();
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: fs.FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly running = new Map<vscode.Terminal, string>();
  /** Chats whose files are still being counted, a slice at a time. */
  private readonly uncounted = new Set<string>();
  private counting = false;
  private again = false;
  private firstLoad = true;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.rewatch()));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("crosstalk") && this.syncConfig()));
    this.moveFromRelay();
    this.keepHookCurrent();
    this.tidyStorage();
    this.syncConfig();
    this.rewatch();
    // A window opened to show a Claude chat opens it now, not after every folder's chats are read.
    void this.takeOpens();
    // Terminals running an agent, as shell integration reports them, so a command for a chat can be
    // typed where that chat already runs. And a window brought forward by another one ("open in its
    // folder") looks for the chat it was asked to open, whether or not the file watcher fired.
    const w = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal; execution?: { commandLine?: { value?: string } } }>;
      onDidEndTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal }>;
      onDidCloseTerminal?: vscode.Event<vscode.Terminal>;
      onDidChangeWindowState?: vscode.Event<{ focused: boolean }>;
    };
    for (const d of [
      w.onDidStartTerminalShellExecution?.((e) => this.running.set(e.terminal, e.execution?.commandLine?.value ?? "")),
      w.onDidEndTerminalShellExecution?.((e) => this.running.delete(e.terminal)),
      w.onDidCloseTerminal?.((t) => this.running.delete(t)),
      w.onDidChangeWindowState?.((st) => st.focused && void this.takeOpens()),
    ])
      if (d) this.disposables.push(d);
    // Last, so nothing above can leave a timer running if it throws.
    const poll = setInterval(() => this.refresh(), POLL_MS);
    this.disposables.push({ dispose: () => clearInterval(poll) });
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // ---- views ----

  attach(webview: vscode.Webview, view: "sidebar" | "board"): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "dist")] };
    webview.html = webviewHtml(webview, this.ctx.extensionUri, view);
    this.views.add(webview);
    const sub = webview.onDidReceiveMessage((m: FromWebview) => this.handle(m, webview));
    return { dispose: () => (this.views.delete(webview), sub.dispose()) };
  }

  openBoard(tab: BoardTab = "board"): void {
    if (this.board) {
      this.board.reveal();
      void this.board.webview.postMessage({ type: "tab", tab } satisfies ToWebview);
      return;
    }
    const panel = vscode.window.createWebviewPanel("crosstalk.board", "Crosstalk", vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "crosstalk-color.svg");
    const detach = this.attach(panel.webview, "board");
    panel.onDidDispose(() => {
      detach.dispose();
      this.board = undefined;
    });
    this.board = panel;
    if (tab !== "board") setTimeout(() => void panel.webview.postMessage({ type: "tab", tab } satisfies ToWebview), 400);
  }

  private post(msg: ToWebview, to?: vscode.Webview): void {
    for (const v of to ? [to] : this.views) void v.postMessage(msg);
  }

  private toast(text: string, tone: "ok" | "warn" = "ok", to?: vscode.Webview, extra: { title?: string; icon?: Extract<ToWebview, { type: "toast" }>["icon"]; undo?: FromWebview } = {}): void {
    this.post({ type: "toast", text, tone, ...extra }, to);
  }

  /** Unlinks, tells both chats (with their next message), and offers Undo. */
  private unlink(ids: string[], view: vscode.Webview, quiet = false): Connection[] {
    const gone: Connection[] = [];
    for (const id of ids) {
      const c = removeConnection(id);
      if (!c) continue;
      gone.push(c);
      this.notice(c.to.id, c.from, `Channel from “${c.from.title}” closed: no more updates will come from it.`, `${c.from.id}>${c.to.id}`);
      this.notice(c.from.id, c.to, `No longer sharing this chat’s work with “${c.to.title}”.`, `${c.from.id}>${c.to.id}`);
    }
    if (gone.length && !quiet) {
      const names = [...new Set(gone.flatMap((c) => [this.ref(c.from).title, this.ref(c.to).title]))];
      this.toast(
        names.length === 2 ? `${short(names[0])} · ${short(names[1])}` : `${gone.length} channels`,
        "ok",
        view,
        { title: "Channel closed", icon: "unlink", undo: { type: "connectMany", pairs: gone.map((c) => [c.from.id, c.to.id]) } },
      );
    }
    return gone;
  }

  /** Sets which way two linked chats share: both ways, a → b, or b → a. */
  private async direction(a: string, b: string, want: "both" | "ab" | "ba", view: vscode.Webview): Promise<void> {
    const all = readConnections();
    const ab = all.find((c) => c.from.id === a && c.to.id === b);
    const ba = all.find((c) => c.from.id === b && c.to.id === a);
    const add: [string, string][] = [];
    if ((want === "both" || want === "ab") && !ab) add.push([a, b]);
    if ((want === "both" || want === "ba") && !ba) add.push([b, a]);
    const remove = [want === "ba" ? ab?.id : undefined, want === "ab" ? ba?.id : undefined].filter((x): x is string => !!x);
    if (add.length) await this.connectMany(add, view, true);
    if (remove.length) this.unlink(remove, view, true);
    const A = this.session(a).title;
    const B = this.session(b).title;
    const text = want === "both" ? `${short(A)} ⇄ ${short(B)}` : want === "ab" ? `${short(A)} → ${short(B)}` : `${short(B)} → ${short(A)}`;
    this.toast(text, "ok", view, { title: want === "both" ? "Both ways" : "One way", icon: "link" });
    await this.refresh();
  }

  // ---- the list of chats ----

  refreshSoon(ms = 300): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), ms);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.load();
    } catch (err) {
      this.state = { ...this.state, loading: false, error: `Crosstalk couldn't read the chats: ${String(err)}` };
      this.post({ type: "state", state: this.state });
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        this.refreshSoon(50);
      }
    }
  }

  private async load(): Promise<void> {
    const root = this.root;
    const claudeExtension = await claudeExtensionInstalled();
    const hooks = this.hookState();
    // "On" means every installed agent has Crosstalk's hook.
    const hooksOn = Object.values(hooks).every(Boolean);
    if (!root) {
      this.state = { ...this.state, root: undefined, sessions: [], connections: [], inbox: {}, hooksOn, claudeExtension, loading: false, error: "Open a folder to see the AI chats you had in it." };
      this.post({ type: "state", state: this.state });
      return;
    }

    const present = this.adapters.filter((a) => a.tool === "Claude" || a.present());
    const errors: string[] = [];
    const lists = await Promise.all(
      present.map((a) =>
        a.list(root, PER_TOOL).catch((err) => {
          errors.push(`${a.tool}: ${String(err)}`);
          return [] as ChatSession[];
        }),
      ),
    );
    // This folder's chats, then the newest chats of every other folder (for "All folders" and for
    // links that reach another folder).
    const mine = lists.flat();
    const seen = new Set(mine.map((s) => s.id));
    const elsewhere = pickElsewhere(
      (await this.elsewhere(present)).filter((s) => !seen.has(s.id)),
      // Linked chats and the board's cards always show, however old.
      new Set([...readConnections().flatMap((c) => [c.from.id, c.to.id]), ...new BoardStore(root).read().members]),
    ).map((s) => ({ ...s, away: !s.cwd || !sameFolder(s.cwd, root) }));
    const sessions = [...mine, ...elsewhere].sort((a, b) => b.lastModified - a.lastModified);
    const totals: ViewState["totals"] = {};
    for (const s of sessions) {
      // Every agent with Crosstalk's hook records its own status.
      const { status, line } = resolveStatus(s.lastModified, readHookStatus(s.id));
      s.status = status;
      s.lastLine = line;
      try {
        if (s.away) {
          // Another folder's history can run to a gigabyte: only its end is read, for the model and context.
          const l = this.adapter(s.tool).latest(s);
          s.model = l?.model;
          s.context = l?.context;
          continue;
        }
        const a = this.adapter(s.tool);
        if ((a.pendingBytes?.(s) ?? 0) > QUICK_BYTES) {
          // Big and not counted yet: the list shows now, with the model and context from the file's
          // end; its tokens follow once counted in the background.
          const l = a.latest(s);
          s.model = l?.model;
          s.context = l?.context;
          this.uncounted.add(s.id);
        } else {
          const u = a.usage(s);
          s.usage = u?.total;
          s.usageToday = u?.today;
          s.model = u?.model;
          s.context = u?.context;
        }
      } catch {
        // Usage is a nicety; a file it can't read just shows none.
        if (s.away) continue;
      }
      const t: ToolTotals = (totals[s.tool] ??= { chats: 0, today: NO_USAGE, total: NO_USAGE });
      t.chats++;
      if (s.usage) t.total = addUsage(t.total, s.usage);
      if (s.usageToday) t.today = addUsage(t.today, s.usageToday);
    }
    this.byId = new Map(sessions.map((s) => [s.id, s]));

    this.pumpQuietSources();

    const deliveries = readDeliveries();
    const connections: ConnectionView[] = readConnections()
      .filter((c) => this.byId.has(c.from.id) || this.byId.has(c.to.id))
      .map((c) => {
        // Only what this link has sent: not what an earlier link between the same chats sent.
        const mine = deliveries.filter((d) => d.at >= c.createdAt && (d.connectionId === c.id || (!d.connectionId && d.from === c.from.id && d.to === c.to.id)));
        return {
          ...c,
          from: this.ref(c.from),
          to: this.ref(c.to),
          updates: mine.length,
          chars: mine.reduce((n, d) => n + d.chars, 0),
          lastAt: mine.length ? mine[mine.length - 1].at : undefined,
        };
      });

    const inbox: ViewState["inbox"] = {};
    for (const s of sessions) {
      const items = readInbox(s.id).filter((i) => i.kind !== "notice");
      if (items.length) inbox[s.id] = { count: items.length, chars: items.reduce((n, i) => n + i.text.length, 0), from: [...new Set(items.map((i) => this.ref(i.from).title))] };
    }

    const store = new BoardStore(root);
    let board = store.read();
    // A new board starts with the chats that matter (linked, busy, the newest few) — once. An empty
    // board after that is one the person cleared, and stays empty until they add chats.
    if (!board.seeded && !board.members.length && sessions.length) {
      const linked = connections.flatMap((c) => [c.from.id, c.to.id]);
      const busy = mine.filter((s) => s.status === "working" || s.status === "waiting").map((s) => s.id);
      const recent = mine.slice(0, 5).map((s) => s.id);
      store.add([...linked, ...busy, ...recent].filter((id) => this.byId.has(id)));
      board = store.update((b) => (b.seeded = true));
    } else if (!board.seeded && board.members.length) {
      board = store.update((b) => (b.seeded = true));
    }

    this.notifyWaiting(sessions);
    this.followCodexPlan();
    void this.refreshPlans();
    this.state = {
      root,
      tools: present.map((a) => a.tool),
      sessions,
      connections,
      inbox,
      board,
      totals,
      hooksOn,
      hooks,
      claudeExtension,
      focus: this.focusOn,
      autoCompact: claudeAutoCompact(),
      plans: this.plans,
      plansLoading: this.plansLoading,
      loading: false,
      error: errors.length ? `Some chats couldn't be read (${errors.join("; ")})` : undefined,
    };
    this.post({ type: "state", state: this.state });
    void this.takeOpens();
    if (this.uncounted.size) void this.countInBackground();
    else {
      for (const a of this.adapters) a.saveCache?.();
      void this.recordInBackground();
    }
  }

  private recording = false;

  /**
   * Session records for this folder's chats and every linked chat, so any of them can be picked up
   * from its record. The hook keeps a record current after each reply; here, only what the hook
   * leaves alone: a quiet chat with no record yet, a big one, or one far behind. A slice at a time, after the
   * token counting, never two at once.
   */
  private async recordInBackground(): Promise<void> {
    if (this.recording || this.counting) return;
    this.recording = true;
    try {
      const linked = new Set(readConnections().flatMap((c) => [c.from.id, c.to.id]));
      const wanted = [...this.byId.values()].filter((s) => s.file && (!s.away || linked.has(s.id)));
      for (const s of wanted) {
        const tool = toolOf(s.tool);
        const behind = recordBehind(s.id, tool, s.file!);
        // A chat replying now is the hook's (it records the ask as the reply ends); a quiet one
        // with no record yet, or a record far behind, is caught up here.
        const quiet = Date.now() - s.lastModified > 120_000;
        const hookWont = readHead(s.id) ? behind > HOOK_STEP_MAX : behind > HOOK_START_MAX || (quiet && behind > 0);
        if (hookWont) await this.ensureRecord(s);
      }
    } catch {
      // A record is a nicety; it is tried again on the next refresh.
    } finally {
      this.recording = false;
    }
  }

  /**
   * Counts the big chat files a slice at a time, letting everything else run between slices, then
   * shows the totals. What is counted is kept, so the next window starts from it.
   */
  private async countInBackground(): Promise<void> {
    if (this.counting) return;
    this.counting = true;
    let lastShown = Date.now();
    try {
      while (this.uncounted.size) {
        const id = this.uncounted.values().next().value!;
        this.uncounted.delete(id);
        const s = this.byId.get(id);
        if (!s) continue;
        const a = this.adapter(s.tool);
        if (a.usageStep) {
          while ((a.pendingBytes?.(s) ?? 0) > 0) {
            a.usageStep(s, SLICE_BYTES);
            await new Promise((r) => setImmediate(r));
          }
        } else {
          a.usage(s);
          await new Promise((r) => setImmediate(r));
        }
        if (Date.now() - lastShown > 2000) {
          lastShown = Date.now();
          this.refreshSoon(0);
        }
      }
    } finally {
      this.counting = false;
      for (const a of this.adapters) a.saveCache?.();
      this.refreshSoon(0);
    }
  }

  // ---- plan limits ----

  private plans: Partial<Record<Tool, PlanUsage>> = {};
  private plansAt = 0;
  private plansLoading = false;

  /**
   * Each agent's account and plan limits, as the agent reports them: Claude's from the person's own
   * Claude Code (its /usage data; nothing is sent to a model and no login is touched), Codex's from
   * its own chat records, Gemini CLI's sign-in. Read at most every five minutes unless asked.
   */
  private async refreshPlans(force = false): Promise<void> {
    if (this.plansLoading || (!force && Date.now() - this.plansAt < PLANS_MS)) return;
    this.plansLoading = true;
    this.plansAt = Date.now();
    if (force) this.post({ type: "state", state: { ...this.state, plansLoading: true } });
    const next: Partial<Record<Tool, PlanUsage>> = {};
    try {
      // An agent counts once it is installed (its home folder exists), even before its first chat, so
      // its card can say what to do next.
      const present = new Set<Tool>([...this.adapters.filter((a) => a.tool === "Claude" || a.present()).map((a) => a.tool), ...hookTargets().filter((t) => t.present()).map((t) => t.tool)]);
      const exe = findClaude();
      if (exe) {
        try {
          next.Claude = await this.claudePlan(exe);
        } catch (err) {
          next.Claude = { tool: "Claude", windows: [], at: Date.now(), source: "Claude Code", note: `Claude Code didn't answer: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      if (present.has("Codex")) next.Codex = this.codexPlan();
      if (present.has("Gemini")) next.Gemini = geminiPlan();
      this.plans = next;
    } finally {
      this.plansLoading = false;
      this.refreshSoon(0);
    }
  }

  private codexPlanMtime = 0;

  /** Codex's limits, from the newest of its chat files that records them (a tail read each). */
  private codexPlan(): PlanUsage {
    let found: PlanUsage | undefined;
    const rollouts = recentRollouts(codexSessionsDir(), 25);
    this.codexPlanMtime = rollouts[0]?.mtime ?? 0;
    for (const { file } of rollouts) if ((found = codexPlanFrom(readTail(file, 256 * 1024)))) break;
    // Whether Codex is signed in is told by its auth file being there; Crosstalk never opens it.
    const signedIn = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"));
    return (
      found ?? {
        tool: "Codex",
        windows: [],
        at: Date.now(),
        source: "Codex",
        note: signedIn ? "Codex shows its limits after its first reply. Use Codex once, and they appear here." : "Sign in to Codex (run codex login in a terminal), use it once, and its limits appear here.",
      }
    );
  }

  /**
   * Codex writes its limits into each chat file as it answers, so they're read again the moment its
   * newest chat file changes, not on the five-minute cycle Claude's need. One folder listing, no more.
   */
  private followCodexPlan(): void {
    if (this.plansLoading || !this.adapters.some((a) => a.tool === "Codex" && a.present())) return;
    const newest = recentRollouts(codexSessionsDir(), 1)[0]?.mtime ?? 0;
    if (!newest || newest <= this.codexPlanMtime) return;
    this.plans = { ...this.plans, Codex: this.codexPlan() };
  }

  private async claudePlan(exe: string): Promise<PlanUsage> {
    const abort = new AbortController();
    const never = (async function* () {
      await new Promise(() => undefined);
    })();
    const q = query({ prompt: never as AsyncIterable<never>, options: { pathToClaudeCodeExecutable: exe, cwd: this.root, persistSession: false, abortController: abort, settingSources: [] } });
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in time")), 20_000));
      const account = await Promise.race([q.accountInfo(), timeout]);
      // The /usage data is marked experimental in the SDK: if it changes or goes, the account still shows.
      let usage: ClaudeUsageAnswer | undefined;
      try {
        const ask = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<ClaudeUsageAnswer> })
          .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (ask) usage = await Promise.race([ask.call(q, { skipBehaviors: true }), timeout]);
      } catch {
        usage = undefined;
      }
      return claudePlanFrom(account, usage);
    } finally {
      abort.abort();
    }
  }

  private elsewhereCache: { at: number; list: ChatSession[] } | undefined;

  /** The newest chats of every folder, from every tool; listed again at most every 30 seconds. */
  private async elsewhere(present: Adapter[]): Promise<ChatSession[]> {
    const hit = this.elsewhereCache;
    if (hit && Date.now() - hit.at < ELSEWHERE_MS) return hit.list.map((s) => ({ ...s }));
    const lists = await Promise.all(present.map((a) => a.list(undefined, ELSEWHERE_PER_TOOL).catch(() => [] as ChatSession[])));
    // A chat without a folder, or whose folder is gone, can't be opened; one in a temp folder is a
    // throwaway (a test, a scratch run): all left out.
    const list = lists.flat().filter((s) => s.cwd && fs.existsSync(s.cwd) && !isTempFolder(s.cwd));
    this.elsewhereCache = { at: Date.now(), list };
    return list.map((s) => ({ ...s }));
  }

  private adapter(tool: Tool): Adapter {
    return this.adapters.find((a) => a.tool === tool)!;
  }

  /** A connection's chat as it is called now (titles change as chats go on). */
  private ref(r: ChatRef): ChatRef {
    const s = this.byId.get(r.id);
    return s ? { id: s.id, tool: s.tool, title: s.title, cwd: s.cwd ?? r.cwd } : r;
  }

  /**
   * Claude chats send their updates from the hook when a reply ends. Other tools
   * have no hook, so their updates go out from here once the chat has gone quiet.
   */
  private pumpQuietSources(): void {
    const now = Date.now();
    const bySource = new Map<string, ReturnType<typeof readConnections>>();
    for (const c of readConnections()) {
      // An agent with Crosstalk's hook sends its own updates when a reply ends; the rest are read here.
      if (c.paused || this.hooked(c.from.tool)) continue;
      bySource.set(c.from.id, [...(bySource.get(c.from.id) ?? []), c]);
    }
    for (const [id, conns] of bySource) {
      const s = this.byId.get(id);
      if (!s) continue;
      const a = this.adapter(s.tool);
      const cursor = getCursor(id);
      if (cursor === undefined) {
        setCursor(id, a.end(s));
        continue;
      }
      if (a.end(s) === cursor || now - s.lastModified < QUIET_MS) continue;
      const words = conns.some((c) => c.level === "full") || !s.file ? a.since(s, cursor) : undefined;
      const read = s.file ? readAsksFrom(toolOf(s.tool), s.file, cursor, 1) : undefined;
      setCursor(id, words?.next ?? read!.next);
      const root = s.cwd ?? this.root;
      for (const c of conns) {
        const to = this.byId.get(c.to.id)?.cwd ?? c.to.cwd;
        const elsewhere = !!(to && root && !sameFolder(to, root));
        const text =
          c.level === "full" || !read
            ? words && buildUpdate(words.messages, words.files, root, s.tool, elsewhere)
            : read.asks.length
              ? renderAsks(read.asks, c.level ?? "ping", { root, absolute: elsewhere })
              : undefined;
        if (text) appendInbox(c.to.id, { connectionId: c.id, from: this.ref(c.from), at: now, kind: "update", text });
      }
    }
  }

  private notifyWaiting(sessions: ChatSession[]): void {
    for (const s of sessions) {
      const before = this.lastStatus.get(s.id);
      this.lastStatus.set(s.id, s.status);
      if (this.firstLoad || s.status !== "waiting" || before === "waiting") continue;
      void vscode.window.showInformationMessage(`“${s.title}” is waiting for you${s.lastLine ? `: ${s.lastLine}` : ""}`, "Open").then((pick) => {
        if (pick) void this.open(s.id);
      });
    }
    this.firstLoad = false;
  }

  /** Watches the folders chats are written to, so cards change as the chats do. */
  private rewatch(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    const root = this.root;
    const targets = [statusDir(), crosstalkFile("inbox")];
    if (root) targets.push(fs.existsSync(claudeProjectFolder(root)) ? claudeProjectFolder(root) : claudeProjectsDir());
    for (const dir of targets) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.watchers.push(fs.watch(dir, () => this.refreshSoon()));
      } catch {
        // The poll still keeps the list current.
      }
    }
    // Another window asking this one to open a chat of this folder.
    try {
      fs.mkdirSync(crosstalkHome(), { recursive: true });
      this.watchers.push(fs.watch(crosstalkHome(), (_e, name) => name === "open-requests.json" && void this.takeOpens()));
    } catch {
      // Requests are also checked after every refresh.
    }
    this.refreshSoon(0);
  }

  // ---- requests from the views ----

  private async handle(m: FromWebview, from: vscode.Webview): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.post({ type: "state", state: this.state }, from);
          this.refreshSoon(0);
          return;
        case "refresh":
          return this.refresh();
        case "open":
          return this.open(m.id);
        case "openInFolder":
          return this.openInFolder(m.id);
        case "openInTerminal":
          return this.openTerminal(m.id);
        case "newChat":
          return this.newChat(m.tool);
        case "openBoard":
          return this.openBoard(m.tab);
        case "setup":
          return this.turnOn();
        case "connect":
          return this.connect(m.from, m.to, !!m.both, from);
        case "connectMany":
          if (m.handles) this.boardStore().update((b) => (b.handles = { ...(b.handles ?? {}), ...m.handles }));
          return this.connectMany(m.pairs, from);
        case "disconnect":
          this.unlink([m.connectionId], from);
          return this.refresh();
        case "disconnectMany":
          this.unlink(m.ids, from);
          return this.refresh();
        case "direction":
          return this.direction(m.a, m.b, m.want, from);
        case "pause": {
          setPaused(m.connectionId, m.paused);
          const c = readConnections().find((x) => x.id === m.connectionId);
          if (c) {
            this.notice(c.to.id, c.from, m.paused ? `Paused: updates from “${c.from.title}” stop until resumed.` : `Resumed: updates from “${c.from.title}” come again.`, `pause:${c.id}`);
            this.toast(`${short(this.ref(c.from).title)} → ${short(this.ref(c.to).title)}`, "ok", from, {
              title: m.paused ? "Paused" : "Resumed",
              icon: m.paused ? "pause" : "play",
              undo: { type: "pause", connectionId: c.id, paused: !m.paused },
            });
          }
          return this.refresh();
        }
        case "syncNow":
          return this.syncNow(m.id);
        case "chatCommand":
          return this.chatCommand(m.id, m.command, m.model);
        case "plans":
          return void this.refreshPlans(true);
        case "codeMap":
          return void this.sendCodeMap(from, m.rebuild, m.root);
        case "codeMapFolder":
          return void this.mapAnotherFolder(from);
        case "codeFind": {
          const map = this.codeMapFor(m.root);
          if (!map) return;
          await map.refresh();
          return this.post({ type: "codeFind", q: m.q, hits: codeHits(map, m.q) }, from);
        }
        case "codeModule": {
          const map = this.codeMapFor(m.root);
          if (!map) return;
          await map.refresh();
          const data = codeModuleView(map, m.id);
          if (data) this.post({ type: "codeModule", data }, from);
          return;
        }
        case "openFile": {
          const base = m.root ?? this.root;
          if (!base) return;
          const uri = vscode.Uri.file(path.join(base, m.path));
          const line = Math.max(0, (m.line ?? 1) - 1);
          return void vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
        }
        case "moduleDoc":
          return void this.moduleDocAction(m.id, m.action, from, m.root);
        case "library":
          return this.post({ type: "library", data: libraryView() }, from);
        case "librarySuggest": {
          const { suggest } = await import("../library/index");
          return this.post({ type: "librarySuggest", q: m.q, names: suggest(m.q, allCommands(), 6).map((x) => x.command.name) }, from);
        }
        case "libraryRun":
          return void openClaude(undefined, `/crosstalk:${m.name} `);
        case "libraryCopy": {
          // The page shows that it copied; no toast on top of it.
          await vscode.env.clipboard.writeText(m.text ?? `/crosstalk:${m.name}`);
          return;
        }
        case "libraryOpen": {
          const c = allCommands().find((x) => x.name === m.name);
          if (c && c.source !== "builtin") return void vscode.window.showTextDocument(vscode.Uri.file(c.source));
          return;
        }
        case "libraryNew":
          return void this.newLibraryCommand();
        case "setUpToolkit":
          await this.setUpToolkit();
          return this.post({ type: "library", data: libraryView() }, from);
        case "runs":
          if (this.runsService) this.post({ type: "runs", data: this.runsService.view() }, from);
          return;
        case "runStart":
          try {
            await this.runsService?.start(m.task, m.agents, { ...(m.tokens ? { tokens: m.tokens } : {}), ...(m.minutes ? { minutes: m.minutes } : {}) }, m.leases);
          } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
          }
          return;
        case "run": {
          const svc = this.runsService;
          if (!svc) return;
          const run = (await import("../core/runs")).readRun(m.id);
          if (m.action === "stop") return void svc.stop(m.id);
          if (m.action === "apply") return void svc.apply(m.id);
          if (m.action === "discard") return void svc.discard(m.id);
          if (m.action === "log") return svc.openLog(m.id);
          if (m.action === "open" && run) return svc.openCopy(run.worktree);
          return;
        }
        case "stopAll":
          return void this.runsService?.stopAll();
        case "automation":
          return this.runsService?.update(m.id, m.action === "remove" ? "remove" : { enabled: m.action === "on" });
        case "automationAdd":
          return this.runsService?.addTemplate(m.index);
        case "automationsPaused":
          return this.runsService?.setPaused(m.paused);
        case "models":
          return this.sendModels(m.tool, from);
        case "fullscreen":
          return this.fullscreen();
        case "autoCompactOn":
          setClaudeAutoCompact(true);
          this.toast("Claude compacts chats by itself when they fill up", "ok", from, { title: "Auto-compact on", icon: "info" });
          return this.refresh();
        case "askBranch":
          return this.askBranch(m.id, from);
        case "branch":
          return this.branch(m, from);
        case "peek":
          return this.peek(m.id, from);
        case "boardAdd":
          this.boardStore().update((b) => {
            if (!b.members.includes(m.id)) b.members.push(m.id);
            if (m.x !== undefined && m.y !== undefined) b.positions[m.id] = { x: Math.round(m.x), y: Math.round(m.y) };
          });
          // From the sidebar, show the board with the chat on it.
          if (m.open) this.openBoard("board");
          return this.refresh();
        case "boardRemove":
          this.boardStore().update((b) => (b.members = b.members.filter((id) => id !== m.id)));
          return this.refresh();
        case "move":
          this.boardStore().update((b) => (b.positions[m.id] = { x: Math.round(m.x), y: Math.round(m.y) }));
          this.state.board.positions[m.id] = { x: m.x, y: m.y };
          return;
        case "boardClear": {
          const before = this.boardStore().read();
          if (!before.members.length) return;
          this.boardStore().update((b) => {
            b.members = [];
            b.positions = {};
            b.seeded = true;
          });
          this.toast(`${before.members.length} card${before.members.length === 1 ? "" : "s"} taken off. Add chats back from the list, a folder at a time or one by one.`, "ok", from, {
            title: "Tower cleared",
            icon: "info",
            undo: { type: "boardRestore", members: before.members, positions: before.positions },
          });
          return this.refresh();
        }
        case "boardRestore":
          this.boardStore().update((b) => {
            b.members = [...new Set([...m.members, ...b.members])];
            b.positions = { ...m.positions, ...b.positions };
          });
          return this.refresh();
        case "linkLevel":
          setLevel(m.ids, m.level);
          return this.refresh();
        case "viewport":
          // Kept quietly: nothing else on screen depends on it.
          this.boardStore().update((b) => (b.viewport = m.viewport));
          this.state.board.viewport = m.viewport;
          return;
        case "boardArrange":
          this.boardStore().update((b) => (b.arrange = m.arrange));
          return this.refresh();
        case "scope":
          // Every folder in the sidebar: the board groups by folder too; back to this folder: by links.
          this.boardStore().update((b) => (b.arrange = m.scope === "all" ? "folder" : "links"));
          return this.refresh();
        case "arrange":
          // Every card placed stays on the board (a drag in "By time" keeps all the chats it showed).
          this.boardStore().update((b) => {
            Object.assign(b.positions, m.positions);
            for (const id of Object.keys(m.positions)) if (!b.members.includes(id)) b.members.push(id);
          });
          return this.refresh();
      }
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), "warn", from);
    }
  }

  private session(id: string): ChatSession {
    const s = this.byId.get(id);
    if (!s) throw new Error("That chat isn't in the list any more. Refresh and try again.");
    return s;
  }

  private boardStore(): BoardStore {
    return new BoardStore(this.requireRoot());
  }

  private async digest(s: ChatSession): Promise<ChatDigest> {
    const d = await this.adapter(s.tool).read(s, this.requireRoot());
    this.digests.set(s.id, d);
    return d;
  }

  /**
   * A chat of another folder, opened where it belongs: that folder's own VS Code window (VS Code
   * brings it forward when it is open, or opens it), where Crosstalk opens this exact chat in Claude's
   * panel. Only ever on request; a plain click resumes it in a terminal here.
   */
  private async openInFolder(id: string): Promise<void> {
    const s = this.session(id);
    if (!s.away || !s.cwd) return this.open(id);
    addOpenRequest({ id: s.id, tool: s.tool, cwd: s.cwd, at: Date.now(), title: s.title });
    this.toast(`Opening “${short(s.title)}” in the ${path.basename(s.cwd)} window`, "ok", undefined, { title: path.basename(s.cwd), icon: "info" });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(s.cwd), { forceNewWindow: true });
    void this.followOpen(s);
  }

  /**
   * Watches the request: done the moment the other window takes it. If that window's Crosstalk doesn't
   * (it runs an older one), Claude's own link goes as soon as the other window is in front, rather
   * than after a fixed wait.
   */
  private async followOpen(s: ChatSession): Promise<void> {
    const start = Date.now();
    let frontSince: number | undefined;
    while (Date.now() - start < OPEN_GIVE_UP_MS) {
      await new Promise((r) => setTimeout(r, 100));
      if (!openRequestWaiting(s.id)) return;
      if (vscode.window.state?.focused === false) frontSince ??= Date.now();
      else frontSince = undefined;
      // Only a Claude chat has a link to fall back on; another agent's waits for that window's Crosstalk.
      if (s.tool === "Claude" && frontSince !== undefined && Date.now() - frontSince >= OPEN_ANSWER_MS) break;
    }
    await this.openFallback(s);
  }

  /**
   * The other window didn't take the request (a window opened before Crosstalk was installed or
   * updated runs the Crosstalk it started with). A Claude chat still opens there: Claude Code's own
   * "open this chat" link goes to the window in front, which is that one while this window is not.
   */
  private async openFallback(s: ChatSession): Promise<void> {
    if (!dropOpenRequest(s.id)) return;
    const folder = path.basename(s.cwd ?? "");
    const otherInFront = vscode.window.state?.focused === false;
    if (s.tool === "Claude" && otherInFront && vscode.env.openExternal) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme || "vscode"}://anthropic.claude-code/open?session=${encodeURIComponent(s.id)}`));
        return;
      } catch {
        // Falls through to the note.
      }
    }
    this.toast(`Reload the ${folder} window once (Developer: Reload Window), then try again`, "warn", undefined, { title: `The ${folder} window didn't open it`, icon: "info" });
  }

  private openingRequests = false;

  /** Chats another window asked this one to open (this window has their folder). */
  private async takeOpens(): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!roots.length || this.openingRequests) return;
    this.openingRequests = true;
    try {
      // Every request opens at once, by id: Claude's in Claude's panel, another agent's resumed in
      // a terminal here. Neither waits for this window to list its chats.
      for (const r of takeOpenRequests(roots)) {
        if (r.tool === "Claude") await this.openClaudeChatWhenReady(r.id);
        else if (this.byId.has(r.id)) await this.open(r.id);
        else this.chatTerminal({ id: r.id, tool: r.tool, cwd: r.cwd, title: r.title ?? r.tool, status: "idle", lastModified: r.at });
      }
    } catch {
      // A request that can't be met is dropped; the chat is still in the list to open by hand.
    } finally {
      this.openingRequests = false;
    }
  }

  /**
   * Opens this exact chat in a window that may have just opened. Claude Code's deep-link command
   * (the one its own "open this chat" link uses) binds a tab to the chat id: it creates it, or
   * brings it forward when that chat is already open, so asking twice never makes a second tab.
   * A window that has just opened also restores the Claude tabs it had before, which can take the
   * front after the first ask; asking again once that has settled leaves the clicked chat in front.
   */
  private async openClaudeChatWhenReady(id: string): Promise<void> {
    const ext = vscode.extensions?.getExtension?.("anthropic.claude-code");
    const wasActive = !!ext?.isActive;
    if (ext && !wasActive) await ext.activate();
    const show = async () => {
      try {
        await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", id);
      } catch {
        await openClaude(id);
      }
    };
    await show();
    // A Claude that has just started restores its old tabs, which can come to the front after the
    // first ask: asking again once that has settled leaves the clicked chat in front.
    if (!wasActive) setTimeout(() => void show(), 2500);
  }

  /** Opens a chat. Context waiting for it goes in with it when the hook can't deliver it. */
  async open(id: string): Promise<void> {
    const s = this.session(id);
    // A Claude chat of this folder opens, itself, in Claude Code's panel. One from another folder,
    // like a terminal agent's, is resumed in a terminal in its own folder, where its history lives:
    // this window stays as it is.
    if (s.tool === "Claude" && !s.away) {
      const waiting = !this.hooked("Claude") ? this.takeForPaste(id) : undefined;
      return openClaude(id, waiting);
    }
    this.chatTerminal(s);
    const waiting = this.hooked(s.tool) ? undefined : this.takeForPaste(id);
    if (waiting) {
      await vscode.env.clipboard.writeText(waiting);
      this.toast(`Copied what connected chats did. Paste it into ${s.tool} (⌘V) once it opens.`);
    }
  }

  private takeForPaste(id: string): string | undefined {
    const items = takeInbox(id);
    if (!items.length) return undefined;
    const now = Date.now();
    for (const i of items) logDelivery({ at: now, connectionId: i.connectionId, from: i.from.id, to: id, chars: i.text.length });
    this.refreshSoon();
    return formatDelivery(items, undefined, this.byId.get(id)?.cwd);
  }

  private openTerminal(id: string): void {
    this.chatTerminal(this.session(id));
  }

  /** The chat resumed in its own terminal (its folder, its exact session); shown again if it is open. */
  private chatTerminal(s: ChatSession): { terminal: vscode.Terminal; reused: boolean } {
    const where = s.away && s.cwd ? ` · ${path.basename(s.cwd)}` : "";
    return openInTerminal(`${s.tool} · ${short(s.title)}${where}`, this.adapter(s.tool).resumeCommand!(s), s.cwd ?? this.root, s.id);
  }

  private async newChat(tool: Tool): Promise<void> {
    if (tool === "Claude") return openClaude(undefined);
    openInTerminal(tool, this.adapter(tool).newCommand!(), this.root);
  }

  private async connect(fromId: string, toId: string, both: boolean, view: vscode.Webview): Promise<void> {
    const pairs: [string, string][] = both ? [[fromId, toId], [toId, fromId]] : [[fromId, toId]];
    return this.connectMany(pairs, view);
  }

  /** Links every pair (from → to): one-to-one, one-to-many, many-to-one or every way. */
  private async connectMany(pairs: [string, string][], view: vscode.Webview, quiet = false): Promise<void> {
    const wanted = pairs.filter(([a, b]) => a !== b && this.byId.has(a) && this.byId.has(b));
    if (!wanted.length) return;
    // The link is saved and drawn at once. What the other chat has done so far (which can mean
    // reading a conversation of a gigabyte) follows in the background, before its next message.
    const fresh: { from: ChatSession; to: ChatSession; connectionId: string }[] = [];
    for (const [a, b] of wanted) {
      const from = this.session(a);
      const to = this.session(b);
      const isNew = !readConnections().some((c) => c.from.id === from.id && c.to.id === to.id);
      const { connection } = addConnection(this.ref(from), this.ref(to));
      if (isNew) fresh.push({ from, to, connectionId: connection.id });
      // Updates start from now: the past goes in the context. (A chat already sharing elsewhere keeps
      // its bookmark, so what it owes those chats isn't skipped.)
      const sharingElsewhere = readConnections().some((c) => c.from.id === from.id && c.to.id !== to.id && !c.paused);
      if (getCursor(from.id) === undefined || (isNew && !sharingElsewhere)) setCursor(from.id, this.adapter(from.tool).end(from));
    }
    this.boardStore().add([...new Set(wanted.flat())]);
    // Started once the line is drawn: reading a big chat's record must not hold up the board.
    if (fresh.length) setTimeout(() => void this.sendContexts(fresh, wanted), 250);
    // A link only works by itself with auto-sharing on: ask now, rather than leave a hint.
    if (wanted.some(([, b]) => !this.hooked(this.session(b).tool))) {
      await this.turnOn();
      this.state.hooksOn = Object.values(this.hookState()).every(Boolean);
    }
    if (!quiet) {
      const [[a0, b0]] = wanted;
      const from = this.session(a0);
      const to = this.session(b0);
      const twoWay = wanted.length === 2 && wanted[1][0] === b0 && wanted[1][1] === a0;
      const what = wanted.length === 1 ? `${short(from.title)} → ${short(to.title)}` : twoWay ? `${short(from.title)} ⇄ ${short(to.title)}` : `${fresh.length || wanted.length} chats`;
      const created = readConnections().filter((c) => wanted.some(([x, y]) => c.from.id === x && c.to.id === y));
      this.toast(what, "ok", view, { title: twoWay ? "Channel open both ways" : wanted.length > 2 ? "Channels open" : "Channel open", icon: "link", undo: { type: "disconnectMany", ids: created.map((c) => c.id) } });
      // Quietly, the caller has more to change first and shows the result once.
      await this.refresh();
    }
  }

  /**
   * What each newly linked chat has done so far, for the chat it now shares with: read one chat at a
   * time, and only delivered if the link is still there (it may have been undone meanwhile).
   */
  /**
   * Crosstalk was called Relay: its data moves to the new names once (~/.relay and each project's
   * .relay folder). Tests, which point Crosstalk at folders of their own, are left alone.
   */
  private moveFromRelay(): void {
    if (!process.env.CROSSTALK_HOME) moveOldHome(crosstalkHome());
    if (!process.env.CROSSTALK_WORKSPACE_DIR) for (const f of vscode.workspace.workspaceFolders ?? []) moveOldWorkspace(f.uri.fsPath, workspaceCrosstalkPath(f.uri.fsPath));
  }

  /**
   * Readable copies of whole conversations are gone (session records replaced them), and a record
   * nothing has used for 30 days goes too, unless its chat is still linked.
   */
  private tidyStorage(): void {
    try {
      fs.rmSync(oldConversationsDir(), { recursive: true, force: true });
      pruneRecords(new Set(readConnections().flatMap((c) => [c.from.id, c.to.id])));
    } catch {
      // Tidying is a nicety.
    }
  }

  /** A chat's record, caught up (a big chat is read a slice at a time, without holding anything up). */
  private async ensureRecord(s: ChatSession): Promise<void> {
    if (!s.file) return;
    await catchUpRecord(s.id, toolOf(s.tool), s.file, { cwd: s.cwd, title: s.title });
    setRecordTitle(s.id, s.title, s.cwd);
  }

  private async sendContexts(fresh: { from: ChatSession; to: ChatSession; connectionId: string }[], wanted: [string, string][]): Promise<void> {
    for (const { from, to, connectionId } of fresh) {
      try {
        const link = readConnections().find((c) => c.id === connectionId);
        if (!link) continue;
        // Linked before: only what is new since it last reached that chat.
        const last = readDeliveries().filter((d) => d.from === from.id && d.to === to.id).pop();
        const text = await this.contextFor(from, { forFolder: to.cwd, level: link.level ?? "ping", since: last?.at });
        if (!readConnections().some((c) => c.id === connectionId)) continue;
        appendInbox(to.id, { connectionId, from: this.ref(from), at: Date.now(), kind: "context", text });
        // The sharing chat is told too, unless the other way already gives it the full context.
        if (!wanted.some(([x, y]) => x === to.id && y === from.id)) this.notice(from.id, this.ref(to), `Channel open: this chat’s work now goes to “${to.title}” after each reply.`, `${from.id}>${to.id}`);
      } catch {
        // The link works without it: updates still flow from the next reply.
      }
    }
    this.refreshSoon(0);
  }

  private async askBranch(id: string, view: vscode.Webview): Promise<void> {
    const s = this.session(id);
    await this.ensureRecord(s);
    // The asks to bring along come from the chat's record: no need to read its whole conversation.
    const asks = readAsks(s.id, 25)
      .reverse()
      .map((a) => ({ id: String(a.n), text: a.ask.replace(/\s+/g, " ").trim().slice(0, 180) }));
    const contextChars = (await this.contextFor(s)).length;
    this.post({ type: "branchInfo", id, title: s.title, tool: s.tool, asks, contextChars }, view);
  }

  private async branch(m: Extract<FromWebview, { type: "branch" }>, view: vscode.Webview): Promise<void> {
    const root = this.requireRoot();
    const s = this.session(m.from);
    const task = m.task.trim();
    if (!task) throw new Error("Say what the new chat should do.");
    const parts: string[] = [];
    if (m.withContext) parts.push(await this.contextFor(s));
    const wanted = new Set(m.askIds);
    const brought = readAsks(s.id)
      .filter((a) => wanted.has(String(a.n)))
      .map((a) => `• Asked: ${a.ask.replace(/\s+/g, " ").trim()}\n  Done: ${a.did}${a.open ? `\n  Open: ${a.open}` : ""}`);
    if (brought.length) parts.push(`Earlier in that chat:\n${brought.join("\n")}`);
    const context = parts.join("\n\n");

    if (m.keepConnected && getCursor(s.id) === undefined) setCursor(s.id, this.adapter(s.tool).end(s));
    const title = task.split("\n")[0].slice(0, 60);
    // The new chat is a Claude Code chat: what matters is Claude's hook.
    if (this.hooked("Claude")) {
      // The new chat opens in this window's folder, wherever the old one lives.
      addPending({ id: randomBytes(6).toString("hex"), from: this.ref(s), title, cwd: root, at: Date.now(), taskStart: task, context, keepConnected: m.keepConnected });
      await openClaude(undefined, task);
      this.toast(`New chat opened with your task. Press Send and it gets “${s.title}”’s context with it.`, "ok", view);
    } else {
      const prompt = context ? `${task}\n\n---\n${formatDelivery([{ from: this.ref(s), at: Date.now(), kind: "context", text: context }])}` : task;
      await openClaude(undefined, prompt);
      this.toast("New chat opened with your task and the context. Turn on auto-sharing to keep them connected.", "warn", view);
    }
  }

  /** How much of a conversation goes over on connecting: the `crosstalk.contextSize` setting. */
  private contextSize(): ContextSize {
    const v = vscode.workspace.getConfiguration("crosstalk").get<string>("contextSize", "standard");
    return (v in CONTEXT_BUDGET ? v : "standard") as ContextSize;
  }

  /** The hook can't read VS Code's settings, so the ones it needs are mirrored to ~/.crosstalk/config.json. */
  syncConfig(): void {
    try {
      const autoDeliver = vscode.workspace.getConfiguration("crosstalk").get<boolean>("autoDeliver", false);
      writeFileAtomic(crosstalkFile("config.json"), JSON.stringify({ contextSize: this.contextSize(), autoDeliver }));
    } catch {
      // Defaults apply.
    }
  }

  /** A chat's conversation for another chat, and a readable copy of all of it in ~/.crosstalk/chats. */
  /**
   * What a chat is told about another, on linking or when a new chat starts from it: that chat's
   * record (what it set out to do and its latest asks), or at "full" its own words up to the size
   * setting. `since`: a link made again only tells what is new.
   */
  private async contextFor(s: ChatSession, opts: { forFolder?: string; level?: LinkLevel; since?: number } = {}): Promise<string> {
    const root = s.cwd ?? this.root;
    const absolute = !!(opts.forFolder && root && !sameFolder(opts.forFolder, root));
    if (opts.level !== "full") {
      await this.ensureRecord(s);
      const text = recordContext(s.id, s.title, { root, absolute, since: opts.since });
      if (text) return text;
    }
    const d = await this.digest(s);
    const budget = CONTEXT_BUDGET[opts.level === "full" ? this.contextSize() : "compact"];
    return buildContext({ from: this.ref(s), digest: d, root, absolute, budget, pointer: s.file ? recordPointer(s.id, s.title) : undefined });
  }


  /** A short note about a link change, delivered with the chat's next message. */
  private notice(chatId: string, about: ChatRef, text: string, topic?: string): void {
    appendInbox(chatId, { from: this.ref(about), at: Date.now(), kind: "notice", text, topic });
  }

  /** One click: open the chat ready to catch up; its next message brings everything waiting. */
  private async syncNow(id: string): Promise<void> {
    const s = this.session(id);
    const ask = "Catch up on what my connected chats did, then tell me in a few lines what changed.";
    if (s.tool !== "Claude" || s.away) return this.open(id);
    if (this.hooked("Claude")) {
      await openClaude(id, ask);
      this.toast(`Press Send in ${short(s.title)}`, "ok", undefined, { title: "Ready to sync", icon: "sync" });
    } else {
      const waiting = this.takeForPaste(id);
      await openClaude(id, waiting ? `${ask}\n\n${waiting}` : ask);
    }
  }

  private focusOn = false;

  /** Focus: the board gets the whole window (side panels hidden); again to bring them back. */
  private modelCache: { at: number; list: ModelOption[] } | undefined;

  /**
   * The models a tool offers, as the tool itself lists them. For Claude this asks
   * the person's own installed Claude Code (the same list its model picker shows):
   * nothing is sent to a model, nothing is saved, and Crosstalk never touches the login.
   * Kept for six hours, in memory and in ~/.crosstalk/models-claude.json.
   */
  private async sendModels(tool: Tool, view: vscode.Webview): Promise<void> {
    if (tool !== "Claude") {
      this.post({ type: "models", tool, models: [], error: `${tool} doesn't list its models to other apps yet.` }, view);
      return;
    }
    try {
      this.post({ type: "models", tool, models: await this.claudeModels() }, view);
    } catch (err) {
      this.post({ type: "models", tool, models: [], error: err instanceof Error ? err.message : String(err) }, view);
    }
  }

  private async claudeModels(): Promise<ModelOption[]> {
    const SIX_HOURS = 6 * 3600_000;
    const file = crosstalkFile("models-claude.json");
    if (!this.modelCache) {
      const saved = readJson<{ at: number; list: ModelOption[] } | undefined>(file, undefined);
      if (saved?.list?.length) this.modelCache = saved;
    }
    if (this.modelCache && Date.now() - this.modelCache.at < SIX_HOURS) return this.modelCache.list;
    const exe = findClaude();
    if (!exe) throw new Error("Couldn't find Claude Code on this computer.");
    const abort = new AbortController();
    const never = (async function* () {
      await new Promise(() => undefined);
    })();
    const q = query({ prompt: never as AsyncIterable<never>, options: { pathToClaudeCodeExecutable: exe, cwd: this.root, persistSession: false, abortController: abort, settingSources: [] } });
    try {
      const models = await Promise.race([q.supportedModels(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code didn't answer in time.")), 20_000))]);
      const list: ModelOption[] = models.map((m) => ({ value: m.value, name: m.displayName, description: m.description, resolved: m.resolvedModel }));
      this.modelCache = { at: Date.now(), list };
      writeFileAtomic(file, JSON.stringify(this.modelCache));
      return list;
    } finally {
      abort.abort();
    }
  }

  /**
   * Opens a chat with one of its agent's own commands ready to send: compacting
   * (/compact in Claude Code and Codex, /compress in Gemini CLI) or the model
   * (/model, with a choice for Claude, the agent's own picker for the others).
   */
  /**
   * /model or /compact for a chat, put where that chat runs, ready for the person to press Enter
   * (Crosstalk never sends it). It is also copied, so it is one paste wherever it can't be typed.
   */
  private async chatCommand(id: string, command: "compact" | "model", model?: string): Promise<void> {
    const s = this.session(id);
    if (model && !/^[A-Za-z0-9._\[\]-]+$/.test(model)) throw new Error("Pick a model.");
    const word = command === "compact" ? (s.tool === "Gemini" ? "/compress" : "/compact") : model ? `/model ${model}` : "/model";
    const title = command === "compact" ? `Compact “${short(s.title)}”` : model ? `Switch to ${this.modelCache?.list.find((x) => x.value === model)?.name ?? model}` : `Pick a model in ${s.tool}`;
    await vscode.env.clipboard.writeText(word);
    if (s.tool === "Claude" && !s.away) return this.claudeCommand(s, word, title);

    // Codex, Gemini CLI and a Claude chat of another folder run in a terminal: typed into the one
    // the chat already runs in; otherwise the chat is resumed in a terminal and it is typed there.
    const live = this.liveTerminal(s);
    if (live) {
      live.show();
      live.sendText(word, false);
      this.toast(`${word} is typed in its terminal: press Enter to run it`, "ok", undefined, { title, icon: "info" });
      return;
    }
    if (s.status === "working" || s.status === "waiting") {
      // Running somewhere Crosstalk can't see (another app, a terminal outside VS Code): a second copy would split the chat.
      this.toast(`It's running outside this window. Paste it there (⌘V), then press Enter`, "ok", undefined, { title: `Copied ${word}`, icon: "info" });
      return;
    }
    const { terminal } = this.chatTerminal(s);
    typeWhenStarted(terminal, word);
    this.toast(`It opens in a terminal with ${word} typed in: press Enter to run it`, "ok", undefined, { title, icon: "info" });
  }

  /**
   * A Claude chat of this folder. Claude Code fills a chat's box only when it opens the chat (an
   * open one keeps its box, and it has no command to set a chat's model), so an open, idle chat's
   * tab is closed and the chat opened again with the command in its box. A chat that is replying
   * is left alone: the command is on the clipboard for when it is done.
   */
  private async claudeCommand(s: ChatSession, word: string, title: string): Promise<void> {
    const tab = claudeTabFor(s.title);
    if (s.status === "working") {
      await openClaude(s.id);
      this.toast(`It's replying. When it's done, paste it in its box (⌘V) and press Enter`, "ok", undefined, { title: `Copied ${word}`, icon: "info" });
      return;
    }
    if (tab) {
      try {
        await vscode.window.tabGroups.close(tab, true);
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        // Left open: the command is on the clipboard.
      }
    }
    await openClaude(s.id, word);
    try {
      await new Promise((r) => setTimeout(r, 250));
      await vscode.commands.executeCommand("claude-vscode.focus");
    } catch {
      // An older Claude Code without the command.
    }
    this.toast(`${word} is in its box: press Enter to run it. If the box is empty, paste it (⌘V)`, "ok", undefined, { title, icon: "info" });
  }

  /**
   * The terminal a chat runs in: the one Crosstalk opened for it, or one shell integration shows
   * running this chat (its id on the command line), or the only one running this agent when the
   * chat is that agent's newest here.
   */
  private liveTerminal(s: ChatSession): vscode.Terminal | undefined {
    const own = ownTerminalFor(s.id);
    if (own) return own;
    const bin = s.tool === "Codex" ? "codex" : s.tool === "Gemini" ? "gemini" : "claude";
    const runsAgent = new RegExp(`(^|[\\s/])${bin}(\\s|$)`);
    const runs = [...this.running].filter(([t, line]) => t.exitStatus === undefined && runsAgent.test(line));
    const byId = runs.filter(([, line]) => line.includes(s.id));
    if (byId.length === 1) return byId[0][0];
    if (runs.length !== 1 || s.away) return undefined;
    const newest = [...this.byId.values()].filter((x) => x.tool === s.tool && !x.away).sort((a, b) => b.lastModified - a.lastModified)[0];
    return newest?.id === s.id && !runs[0][1].match(/(resume|--resume|-r)\s/) ? runs[0][0] : undefined;
  }

  private async fullscreen(): Promise<void> {
    this.openBoard("board");
    const run = async (...ids: string[]) => {
      for (const id of ids) {
        try {
          await vscode.commands.executeCommand(id);
        } catch {
          // A command this VS Code lacks is skipped.
        }
      }
    };
    if (!this.focusOn) {
      await run("workbench.action.closeSidebar", "workbench.action.closeAuxiliaryBar", "workbench.action.closePanel");
      this.focusOn = true;
    } else {
      await run("workbench.action.toggleSidebarVisibility", "workbench.action.toggleAuxiliaryBar");
      this.focusOn = false;
    }
    this.board?.reveal();
    this.state.focus = this.focusOn;
    this.post({ type: "state", state: this.state });
  }

  private peek(id: string, view: vscode.Webview): void {
    const s = this.session(id);
    const items = readInbox(id);
    const text = items.length ? formatDelivery(items, undefined, this.byId.get(id)?.cwd) : "Nothing is on its way to this chat.";
    this.post({ type: "peek", id, title: s.title, text }, view);
  }

  private requireRoot(): string {
    if (!this.root) throw new Error("Open a folder first.");
    return this.root;
  }

  // ---- setup: the hook (live status and delivery) and the notes tools (MCP) ----

  private keepHookCurrent(): void {
    try {
      fs.mkdirSync(crosstalkHome(), { recursive: true });
      fs.copyFileSync(path.join(this.ctx.extensionPath, "dist", "crosstalk-hook.js"), path.join(crosstalkHome(), "crosstalk-hook.js"));
      // Crosstalk's tools (notes, session records), once added, stay as new as the extension.
      if (fs.existsSync(path.join(crosstalkHome(), "crosstalk-mcp.js"))) this.copyTools();
      refreshCodexPrompts();
      // A hook that names a node no longer there (an nvm version removed) is rewritten with today's.
      const stale = staleHookTargets();
      if (stale.length) {
        const node = findNode();
        for (const t of stale) connect(hookCommandFor(node, t.tool), t.file, t.events, t.timeout);
      }
    } catch {
      // Not built yet, or no permission: turning on reports it.
    }
  }

  /** Offers auto-sharing once, the first time Crosstalk runs without it. */
  async offerSetupOnce(): Promise<void> {
    const key = "crosstalk.offeredSetup";
    const memory = this.ctx.globalState;
    if (!memory || isConnected() || memory.get<boolean>(key)) return;
    await memory.update(key, true);
    const pick = await vscode.window.showInformationMessage(
      "Crosstalk: turn on auto-sharing so connected chats keep each other up to date by themselves?",
      "Turn on",
      "Not now",
    );
    if (pick === "Turn on") await this.turnOn();
  }

  /** Which installed agents have Crosstalk's hook. */
  private hookState(): Partial<Record<Tool, boolean>> {
    const out: Partial<Record<Tool, boolean>> = {};
    for (const t of hookTargets()) if (t.present()) out[t.tool] = isToolConnected(t);
    return out;
  }

  private hooked(tool: Tool): boolean {
    return !!this.state.hooks?.[tool] || !!this.hookState()[tool];
  }

  async turnOn(): Promise<void> {
    const targets = hookTargets().filter((t) => t.present());
    const missing = targets.filter((t) => !isToolConnected(t));
    if (!missing.length) {
      this.toast("Every agent here already shares.", "ok", undefined, { title: "Auto-sharing is on", icon: "info" });
      return;
    }
    const names = missing.map((t) => t.tool).join(", ");
    const ok = await vscode.window.showInformationMessage(
      `Turn on auto-sharing for ${names}?`,
      {
        modal: true,
        detail: [
          `Crosstalk adds a small hook to each agent's own settings (${missing.map((t) => t.file.replace(os.homedir(), "~")).join(", ")}; a backup of each is kept).`,
          "With it, connected chats get each other's work by themselves, across agents, and every chat shows whether it is working, waiting for you or done. It never touches your logins.",
          ...missing.filter((t) => t.note).map((t) => t.note!),
          "Turn it off any time with “Crosstalk: Turn off auto-sharing”.",
        ].join("\n\n"),
      },
      "Turn on",
    );
    if (ok !== "Turn on") return;
    this.keepHookCurrent();
    if (!fs.existsSync(installedHookPath())) throw new Error("The hook script is missing. Rebuild Crosstalk (npm run build) and try again.");
    const node = findNode();
    for (const t of missing) connect(hookCommandFor(node, t.tool), t.file, t.events, t.timeout);
    const codex = missing.find((t) => t.tool === "Codex");
    this.toast(codex ? "Last step for Codex: type /hooks in Codex and trust Crosstalk's hook." : `Chats in ${names} pick it up from now.`, "ok", undefined, {
      title: "Auto-sharing on",
      icon: "link",
    });
    this.refreshSoon(0);
  }

  turnOff(): void {
    for (const t of hookTargets()) if (t.present()) disconnect(t.file);
    this.toast("Connected chats stop updating each other.", "ok", undefined, { title: "Auto-sharing off", icon: "pause" });
    this.refreshSoon(0);
  }

  /** The MCP server and the code map's parser files, copied to ~/.crosstalk where every agent can run them. */
  private copyTools(): string {
    const target = path.join(crosstalkHome(), "crosstalk-mcp.js");
    fs.mkdirSync(path.join(crosstalkHome(), "wasm"), { recursive: true });
    fs.copyFileSync(path.join(this.ctx.extensionPath, "dist", "crosstalk-mcp.js"), target);
    // The command line sits next to it: `node ~/.crosstalk/crosstalk.js find ...` on any computer.
    const cli = path.join(this.ctx.extensionPath, "dist", "crosstalk.js");
    if (fs.existsSync(cli)) fs.copyFileSync(cli, path.join(crosstalkHome(), "crosstalk.js"));
    const wasm = path.join(this.ctx.extensionPath, "dist", "wasm");
    for (const f of fs.existsSync(wasm) ? fs.readdirSync(wasm) : []) fs.copyFileSync(path.join(wasm, f), path.join(crosstalkHome(), "wasm", f));
    return target;
  }

  // ---- the Code and Library pages ----

  private codeMaps?: { mapFor(root: string): CodeMap | undefined };
  private runsService?: RunsService;

  /** Runs and automations, shared with the extension; their changes reach every open page. */
  useRuns(service: RunsService): void {
    this.runsService = service;
    this.disposables.push(service.onChange(() => this.post({ type: "runs", data: service.view() })));
  }
  private ownMap?: CodeMap;

  /** The code map service from the extension, shared so the folder is mapped once. */
  useCodeMaps(service: { mapFor(root: string): CodeMap | undefined }): void {
    this.codeMaps = service;
  }

  private projectMaps = new Map<string, CodeMap>();

  /** The map of this window's folder, or of another project picked on the Code page. */
  private codeMapFor(root = this.root): CodeMap | undefined {
    if (!root) return undefined;
    const shared = this.codeMaps?.mapFor(root);
    if (shared) return shared;
    let map = this.projectMaps.get(root);
    if (!map) this.projectMaps.set(root, (map = new CodeMap(root)));
    return map;
  }

  private async sendCodeMap(to: vscode.Webview, rebuild = false, root = this.root): Promise<void> {
    const map = this.codeMapFor(root);
    if (!map || !root) return;
    const projects = knownProjects(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      this.ctx.globalState.get<string[]>(MAPPED_FOLDERS, []),
    );
    if (!map.exists()) this.post({ type: "codeMap", data: { root, files: 0, decls: 0, languages: {}, modules: [], edges: [], unused: { files: 0, exports: 0, localOnly: 0, sample: [] }, staleDocs: [], conventions: [], allFiles: [], links: [], projects, building: true } }, to);
    await map.refresh({ full: rebuild });
    this.post({ type: "codeMap", data: { ...codeMapView(map, root), projects } }, to);
  }

  /** Any folder on this computer, picked in the system's folder dialog; it stays in the project list. */
  private async mapAnotherFolder(to: vscode.Webview): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Map this folder", title: "Map a project" });
    const root = picked?.[0]?.fsPath;
    if (!root) return;
    const list = [root, ...this.ctx.globalState.get<string[]>(MAPPED_FOLDERS, []).filter((r) => r !== root)].slice(0, 20);
    await this.ctx.globalState.update(MAPPED_FOLDERS, list);
    this.post({ type: "codeRoot", root }, to);
  }

  private async moduleDocAction(id: string, action: "draft" | "open" | "approve", to: vscode.Webview, root?: string): Promise<void> {
    const map = this.codeMapFor(root);
    if (!map) return;
    const doc = map.moduleDoc(id);
    if (action === "draft") return void openClaude(undefined, `/crosstalk:module-docs ${id}`);
    if (action === "open" && doc && doc.status !== "missing") return void vscode.window.showTextDocument(vscode.Uri.file(doc.file));
    if (action === "approve" && doc && doc.status !== "missing") {
      map.approveModuleDoc(id);
      this.post({ type: "toast", title: "Approved", text: `Agents now get the ${id} doc when they outline it. Commit docs/modules/ to share it.`, icon: "info" }, to);
      return this.sendCodeMap(to, false, root);
    }
  }

  /** Starts a command of the person's own, in ~/.crosstalk/library, from a short template. */
  private async newLibraryCommand(): Promise<void> {
    const dir = userLibraryDir();
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(dir, `my-command${n > 1 ? `-${n}` : ""}.md`))) n++;
    const name = `my-command${n > 1 ? `-${n}` : ""}`;
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ntitle: My command\ndescription: ${STARTER_DESCRIPTION}\nargs: topic* = What to work on; style = How to write it (default: short and plain)\ntriggers: words, someone, might, type\n---\nWork on {{topic}}, written {{style}}.\n\n1. First step.\n2. Second step.\n`,
    );
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.window.showInformationMessage("Your own command: private to this computer, and live in every agent as soon as you save it. Rename it with the name: line.");
  }

  /** Gives the chosen agents Crosstalk's tools (code map, flightlogs, notes) and the Library's commands. */
  async setUpToolkit(): Promise<void> {
    const states = agentStates();
    const picks = await vscode.window.showQuickPick(
      states.map((a) => ({
        label: a.name,
        description: !a.present ? "not found on this computer" : a.tools ? "already set up: refresh it" : "",
        picked: a.present,
        id: a.id,
      })),
      { canPickMany: true, title: "Give these agents Crosstalk's tools and commands", placeHolder: "The code map, flightlogs, notes, and commands such as /plan, /review and /pr" },
    );
    if (!picks?.length) return;
    const what = picks.map((p) => p.label).join(", ");
    const ok = await vscode.window.showInformationMessage(
      `Add Crosstalk to ${what}?`,
      { modal: true, detail: "Each agent's settings are backed up first. Claude Code: added through its own `claude mcp add`. Codex: a [mcp_servers.crosstalk] table in config.toml, and the commands as prompt files. Gemini CLI: an mcpServers entry in settings.json. Remove it any time with \"Crosstalk: Remove the toolkit\"." },
      "Add",
    );
    if (ok !== "Add") return;
    this.copyTools();
    const lines = await installToolkit(
      picks.map((p) => p.id),
      { node: findNode(), claudeCli: findClaude() },
    );
    void vscode.window.showInformationMessage(`${lines.join(" ")} Start a new chat to use them.`);
  }

  async removeToolkit(): Promise<void> {
    const states = agentStates().filter((a) => a.tools || a.commands);
    if (!states.length) {
      void vscode.window.showInformationMessage("No agent has Crosstalk's tools.");
      return;
    }
    const picks = await vscode.window.showQuickPick(
      states.map((a) => ({ label: a.name, picked: true, id: a.id })),
      { canPickMany: true, title: "Remove Crosstalk's tools and commands from" },
    );
    if (!picks?.length) return;
    const lines = await removeToolkit(picks.map((p) => p.id), { claudeCli: findClaude() });
    void vscode.window.showInformationMessage(lines.join(" "));
  }

  async addNotesTools(): Promise<void> {
    return this.setUpToolkit();
  }

  newChatCommand(): Promise<void> {
    return this.newChat("Claude");
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const w of this.watchers) w.close();
    for (const d of this.disposables) d.dispose();
    this.board?.dispose();
  }
}

/** A chat's name, cut to fit a one-line notice. */
/**
 * Claude Code's editor tab for a chat. Claude names the tab after the chat, cut to 24 characters
 * and "…" past 25; two chats with the same name can't be told apart, so neither is touched.
 */
function claudeTabFor(title: string): vscode.Tab | undefined {
  const cut = title.length > 25 ? title.substring(0, 24) + "…" : title;
  const tabs = (vscode.window.tabGroups?.all ?? []).flatMap((g) => g.tabs);
  const hits = tabs.filter((t) => /claudeVSCodePanel/.test((t.input as { viewType?: string } | undefined)?.viewType ?? "") && (t.label === cut || t.label === title));
  return hits.length === 1 ? hits[0] : undefined;
}

function short(title: string, max = 28): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/** Claude Code compacts a chat by itself near full unless switched off (its setting, or an environment variable). */
function claudeAutoCompact(): boolean {
  if (process.env.DISABLE_AUTO_COMPACT || process.env.DISABLE_COMPACT) return false;
  const cfg = readJson<{ autoCompactEnabled?: boolean }>(path.join(os.homedir(), ".claude.json"), {});
  return cfg.autoCompactEnabled !== false;
}

/** Switches Claude Code's own auto-compact setting (one key in ~/.claude.json; nothing else is touched). */
function setClaudeAutoCompact(on: boolean): void {
  const file = path.join(os.homedir(), ".claude.json");
  const cfg = readJson<Record<string, unknown>>(file, {});
  cfg.autoCompactEnabled = on;
  writeFileAtomic(file, JSON.stringify(cfg, null, 2));
}

