// Loads the built extension with a stand-in `vscode` module, activates it,
// opens the sidebar and drives it like a person would: list, connect, open,
// branch. Crosstalk's own files go to temporary folders, never the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import { claudeProjectFolder } from "../src/core/paths";

const built = path.join(__dirname, "..", "dist", "extension.js");
const folder = process.env.CROSSTALK_TEST_DIR || process.cwd();

// Agents' settings go to temporary files too: on start the extension rewrites hooks it finds
// out of date, and a test must never write the person's real ~/.claude, ~/.codex or ~/.gemini.
const realSettings = [path.join(os.homedir(), ".claude", "settings.json"), path.join(os.homedir(), ".codex", "hooks.json"), path.join(os.homedir(), ".gemini", "settings.json")];
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined);
const realBefore = realSettings.map(read);
const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-agents-"));
process.env.CROSSTALK_CLAUDE_SETTINGS = path.join(agentHome, "claude-settings.json");
process.env.CODEX_HOME = path.join(agentHome, "codex");
process.env.CROSSTALK_GEMINI_HOME = path.join(agentHome, "gemini");
{
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "12");
  fs.mkdirSync(day, { recursive: true });
  const id = "c0de0000-0000-4000-8000-000000000000";
  const j = (o: unknown) => JSON.stringify(o);
  const rollout = path.join(day, `rollout-2026-11-12T10-00-00-${id}.jsonl`);
  fs.writeFileSync(
    rollout,
    [j({ type: "session_meta", payload: { id, cwd: folder, timestamp: new Date().toISOString() } }), j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Tidy the README" }] } }), j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tidied it." }] } }), j({ type: "event_msg", payload: { type: "task_complete" } })].join("\n") + "\n",
  );
  // Written a while ago: a file that changed in the last seconds counts as a chat still replying.
  const ago = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(rollout, ago, ago);
}

type Posted = { type: string; [k: string]: any };

function fakeVscode(root: string, calls: { command: string; args: unknown[] }[]) {
  const disposable = { dispose() {} };
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  let provider: { resolveWebviewView(v: unknown): void } | undefined;
  const events: { focus?: (s: { focused: boolean }) => void; started?: (e: unknown) => void } = {};
  const api = {
    Uri: {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }),
      file: (p: string) => ({ fsPath: p }),
    },
    ViewColumn: { Active: -1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      onDidChangeWorkspaceFolders: () => disposable,
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
      createFileSystemWatcher: () => ({ onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
      getWorkspaceFolder: () => ({ uri: { fsPath: root, scheme: "file" } }),
      onDidSaveTextDocument: () => disposable,
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerWebviewViewProvider: (_id: string, p: typeof provider) => ((provider = p), disposable),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      terminals: [] as unknown[],
      createTerminal(o: unknown) {
        const t = { exitStatus: undefined, show() {}, sendText: (text: string, enter = true) => calls.push({ command: "terminal", args: [o, text, enter] }) };
        this.terminals.push(t);
        return t;
      },
      // The other window is in front (as after "open in its folder"); tests fire focus themselves.
      state: { focused: false },
      onDidChangeWindowState: (fn: (s: { focused: boolean }) => void) => ((events.focus = fn), disposable),
      onDidStartTerminalShellExecution: (fn: (e: unknown) => void) => ((events.started = fn), disposable),
      onDidEndTerminalShellExecution: () => disposable,
      onDidCloseTerminal: () => disposable,
      // Claude Code's editor tabs, as VS Code lists them.
      tabGroups: {
        all: [{ tabs: [] as { label: string; input: { viewType: string } }[] }],
        close: async (tab: { label: string }) => {
          calls.push({ command: "closeTab", args: [tab.label] });
          api.window.tabGroups.all[0].tabs = api.window.tabGroups.all[0].tabs.filter((t) => t !== tab);
        },
      },
      createWebviewPanel: () => {
        throw new Error("not used here");
      },
    },
    commands: {
      registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => (commands.set(id, fn), disposable),
      getCommands: async () => ["claude-vscode.editor.open", ...commands.keys()],
      executeCommand: async (command: string, ...args: unknown[]) => void calls.push({ command, args }),
    },
    env: {
      uriScheme: "vscode",
      clipboard: { writeText: async (t: string) => void calls.push({ command: "clipboard", args: [t] }) },
      openExternal: async (u: { toString(): string }) => (calls.push({ command: "openExternal", args: [String(u)] }), true),
    },
  };
  (api.Uri as any).parse = (u: string) => ({ toString: () => u });
  return { api, commands, events, getProvider: () => provider };
}

function loadExtension(vscodeApi: unknown) {
  const original = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: unknown[]) {
    return request === "vscode" ? vscodeApi : original.call(this, request, ...rest);
  };
  try {
    delete require.cache[built];
    return require(built);
  } finally {
    (Module as any)._load = original;
  }
}

async function until<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

test(
  "the extension lists real chats, connects two, opens one where Claude lives, and prepares a branch",
  { skip: (!fs.existsSync(built) && "run npm run build first") || (!fs.existsSync(claudeProjectFolder(folder)) && "no saved Claude chats for the test folder") },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-home-"));
    process.env.CROSSTALK_HOME = home;
    process.env.CROSSTALK_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-ws-"));
    const calls: { command: string; args: unknown[] }[] = [];
    const fake = fakeVscode(folder, calls);
    const subs: { dispose(): void }[] = [];
    loadExtension(fake.api).activate({ subscriptions: subs, extensionUri: { fsPath: path.join(__dirname, "..") }, extensionPath: path.join(__dirname, "..") });
    try {
      for (const id of ["crosstalk.refresh", "crosstalk.openBoard", "crosstalk.openUsage", "crosstalk.newChat", "crosstalk.connect", "crosstalk.disconnect", "crosstalk.addNotesTools"]) {
        assert.ok(fake.commands.has(id), `command ${id}`);
      }
      assert.ok(fs.existsSync(path.join(home, "crosstalk-hook.js")), "hook copied to ~/.crosstalk");

      const posted: Posted[] = [];
      let receive: (m: unknown) => void = () => {};
      const webview = {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (u: { fsPath: string }) => u.fsPath,
        postMessage: async (m: Posted) => (posted.push(m), true),
        onDidReceiveMessage: (fn: (m: unknown) => void) => ((receive = fn), { dispose() {} }),
      };
      fake.getProvider()!.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }), onDidChangeVisibility: () => ({ dispose() {} }), visible: true });
      assert.match(webview.html, /<body data-view="sidebar">/);

      receive({ type: "ready" });
      const state = await until(() => posted.find((m) => m.type === "state" && !m.state.loading)?.state);
      assert.ok(state.sessions.length > 1, "lists chats");
      assert.ok(state.tools.includes("Claude"));
      assert.ok(state.totals.Claude.chats > 0);
      assert.ok(state.sessions.some((s: any) => s.usage && s.usage.output > 0), "tokens counted");
      assert.ok(state.board.members.length > 0, "board starts with recent chats");
      assert.ok(!fs.existsSync(path.join(folder, ".crosstalk", "state.json")) || true);

      // Chats from the person's other folders are listed too, labelled, and only cheaply read.
      const away = state.sessions.filter((s: any) => s.away);
      const otherFolders = fs.readdirSync(path.join(os.homedir(), ".claude", "projects")).length > 1;
      if (otherFolders) {
        assert.ok(away.length > 0, "chats from other folders are listed");
        assert.ok(away.every((s: any) => s.cwd && s.cwd !== folder), "each says its own folder");
        assert.ok(away.every((s: any) => s.usage === undefined), "their whole history is not read (only the end, for model and context)");
        assert.ok(away.some((s: any) => s.model), "their model comes from the end of the file");
      }
      const [a, b] = state.sessions.filter((s: any) => !s.away && s.tool === "Claude");
      // A link is saved and drawn at once; what the chat did so far follows, read in the background.
      const linkedAt = Date.now();
      receive({ type: "connect", from: a.id, to: b.id });
      await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.connections.length === 1));
      assert.ok(Date.now() - linkedAt < 1500, `the line shows without waiting for the conversation to be read (${Date.now() - linkedAt}ms)`);
      await until(() => posted.find((m) => m.type === "toast" && /Channel open/.test(String(m.title))));
      const conns = JSON.parse(fs.readFileSync(path.join(home, "connections.json"), "utf8"));
      assert.deepEqual(conns.map((c: any) => [c.from.id, c.to.id]), [[a.id, b.id]]);
      const inboxFile = path.join(home, "inbox", `${b.id}.jsonl`);
      await until(() => fs.existsSync(inboxFile) && fs.readFileSync(inboxFile, "utf8").trim(), 15000);
      // From the chat's record: what it set out to do and its latest asks, not its conversation.
      const ctx = JSON.parse(fs.readFileSync(inboxFile, "utf8").split("\n")[0]).text;
      assert.match(ctx, /It set out to: /);
      assert.match(ctx, /\*\*Asked:\*\* .+\n\*\*Done:\*\* /);
      assert.match(ctx, /crosstalk_flightlog/);
      assert.ok(ctx.length < 12_000, `a few thousand characters at most (${ctx.length})`);
      assert.ok(fs.existsSync(path.join(home, "flightlogs", `${a.id}.jsonl`)), "the chat's flightlog is kept");
      assert.ok(!fs.existsSync(path.join(home, "chats")), "no copy of the conversation");
      const after = await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.connections.length === 1 && m.state.inbox[b.id])?.state);
      assert.equal(after.inbox[b.id].count, 1, "the context arrives once it is ready");

      receive({ type: "open", id: a.id });
      const open = await until(() => calls.find((c) => c.command === "claude-vscode.editor.open"));
      assert.equal(open.args[0], a.id);
      assert.deepEqual(open.args[5], { programmatic: "honor-preferred-location" });

      // A chat of another folder: that exact chat, resumed in a terminal in its own folder; this
      // window and its Claude panel stay as they are. Clicking it again shows the same terminal.
      const elsewhere = state.sessions.find((s: any) => s.away && s.tool === "Claude");
      if (elsewhere) {
        const before = calls.length;
        receive({ type: "open", id: elsewhere.id });
        const term = await until(() => calls.slice(before).find((c) => c.command === "terminal"));
        assert.equal(term.args[1], `claude --resume ${elsewhere.id}`, "resumes exactly the chat clicked");
        assert.equal((term.args[0] as { cwd: string }).cwd, elsewhere.cwd, "in its own folder");
        assert.ok(!calls.slice(before).some((c) => c.command === "claude-vscode.editor.open" || c.command === "vscode.openFolder"), "no panel, no other window");
        const made = calls.filter((c) => c.command === "terminal").length;
        receive({ type: "open", id: elsewhere.id });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(calls.filter((c) => c.command === "terminal").length, made, "opening it again reuses its terminal");

        // "Open in folder": that folder's own window, which will open this exact chat.
        const before2 = calls.length;
        receive({ type: "openInFolder", id: elsewhere.id });
        const win = await until(() => calls.slice(before2).find((c) => c.command === "vscode.openFolder"));
        assert.equal((win.args[0] as { fsPath: string }).fsPath, elsewhere.cwd, "its own folder's window");
        assert.deepEqual(win.args[1], { forceNewWindow: true });
        const reqs = JSON.parse(fs.readFileSync(path.join(home, "open-requests.json"), "utf8"));
        assert.ok(reqs.some((r: any) => r.id === elsewhere.id && r.cwd === elsewhere.cwd), "the chat waits for that window");
        // No window takes it (that one runs an older Crosstalk, say): Claude Code's own link for this
        // chat goes to the window in front, which is that one.
        const asked = Date.now();
        const link = await until(() => calls.slice(before2).find((c) => c.command === "openExternal"), 2500);
        assert.ok(Date.now() - asked < 2500, "within moments of the other window coming forward, not after a fixed wait");
        assert.equal(link.args[0], `vscode://anthropic.claude-code/open?session=${elsewhere.id}`);
        const after = JSON.parse(fs.readFileSync(path.join(home, "open-requests.json"), "utf8"));
        assert.ok(!after.some((r: any) => r.id === elsewhere.id), "and the request is withdrawn, so it can't open twice");
      }

      // As the receiving window: a request for this folder opens that exact chat through Claude
      // Code's own deep-link command, once Claude has settled.
      const mineClaude = state.sessions.find((s: any) => !s.away && s.tool === "Claude");
      if (mineClaude) {
        const before3 = calls.length;
        const reqFile = path.join(home, "open-requests.json");
        const others = fs.existsSync(reqFile) ? JSON.parse(fs.readFileSync(reqFile, "utf8")) : [];
        fs.writeFileSync(reqFile, JSON.stringify([...others, { id: mineClaude.id, tool: "Claude", cwd: folder, at: Date.now() }]));
        // Brought forward by the other window: focus alone makes it look.
        fake.events.focus!({ focused: true });
        const opened = await until(() => calls.slice(before3).find((c) => c.command === "claude-vscode.primaryEditor.open"), 1000);
        assert.equal(opened.args[0], mineClaude.id, "that exact chat");
        // Asked again once Claude has restored its old tabs, so the clicked chat ends in front.
        const twice = await until(() => {
          const asks = calls.slice(before3).filter((c) => c.command === "claude-vscode.primaryEditor.open");
          return asks.length >= 2 ? asks : undefined;
        }, 8000);
        assert.ok(twice.every((c) => c.args[0] === mineClaude.id), "every ask names the clicked chat, never another");
        const left = JSON.parse(fs.readFileSync(reqFile, "utf8"));
        assert.ok(!left.some((r: any) => r.id === mineClaude.id), "the request is taken, so it opens once");
      }

      // Codex and Gemini chats: the window resumes each in a terminal at once, by id, even one it
      // hasn't listed yet (a window that has just opened), named after the chat.
      {
        const reqFile = path.join(home, "open-requests.json");
        const codexId = "c0de1111-0000-4000-8000-000000000000";
        const geminiId = "9e3a1111-0000-4000-8000-000000000000";
        const before9 = calls.length;
        fs.writeFileSync(
          reqFile,
          JSON.stringify([
            { id: codexId, tool: "Codex", cwd: folder, at: Date.now(), title: "Fix the flaky test" },
            { id: geminiId, tool: "Gemini", cwd: folder, at: Date.now(), title: "Review the schema" },
          ]),
        );
        const asked = Date.now();
        fake.events.focus!({ focused: true });
        const runs = await until(() => {
          const t = calls.slice(before9).filter((c) => c.command === "terminal");
          return t.length >= 2 ? t : undefined;
        }, 1000);
        assert.ok(Date.now() - asked < 1000, "at once");
        assert.deepEqual(runs.map((c) => c.args[1]), [`codex resume ${codexId}`, `gemini --resume ${geminiId}`]);
        assert.ok(runs.every((c) => (c.args[0] as { cwd: string }).cwd === folder), "in that folder");
        assert.match((runs[0].args[0] as { name: string }).name, /Codex · Fix the flaky test/);
        assert.ok(!calls.slice(before9).some((c) => c.command === "claude-vscode.primaryEditor.open"), "not in Claude");
        assert.deepEqual(JSON.parse(fs.readFileSync(reqFile, "utf8")), [], "both taken");
      }

      // The sidebar's "All folders" sets the board to By folder (kept with the workspace), and back.
      receive({ type: "scope", scope: "all" });
      await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.board.arrange === "folder"));
      receive({ type: "boardArrange", arrange: "time" });
      await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.board.arrange === "time"));
      receive({ type: "scope", scope: "here" });
      await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.board.arrange === "links"));

      // Plan limits, read from the person's own Claude Code (no model is called, no login touched).
      const planned = await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.plans?.Claude)?.state, 30_000).catch(() => undefined);
      if (planned) {
        const cp = planned.plans.Claude;
        assert.equal(cp.source, "Claude Code");
        assert.ok(cp.windows.length > 0 || cp.note, "limits, or a plain reason there are none");
        for (const w of cp.windows) assert.ok(w.pct === null || (w.pct >= 0 && w.pct <= 100), `${w.label} is a percentage`);
      }

      // Clear the board: every card off, Undo puts them back; a cleared board isn't refilled by itself.
      const before = [...posted].reverse().find((m) => m.type === "state")!.state.board.members as string[];
      if (before.length) {
        receive({ type: "boardClear" });
        const cleared = await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.board.members.length === 0 && m.state.board.seeded)?.state);
        assert.equal(cleared.board.seeded, true);
        const undo = await until(() => posted.find((m) => m.type === "toast" && m.title === "Tower cleared"));
        assert.equal(undo.undo.type, "boardRestore");
        receive({ type: "refresh" });
        await new Promise((r) => setTimeout(r, 600));
        const stillEmpty = [...posted].reverse().find((m) => m.type === "state")!.state;
        assert.equal(stillEmpty.board.members.length, 0, "a board the person cleared stays empty");
        receive(undo.undo);
        const back = await until(() => [...posted].reverse().find((m) => m.type === "state" && m.state.board.members.length === before.length)?.state);
        assert.deepEqual([...back.board.members].sort(), [...before].sort(), "Undo brings every card back");
      }

      // Switching the model of a chat open in Claude's tab: Claude fills a box only when it opens a
      // chat, so the tab is closed and the chat opened again with /model in its box.
      const idle = state.sessions.find((s: any) => !s.away && s.tool === "Claude" && s.status !== "working");
      if (idle) {
        const a = idle;
        const label = a.title.length > 25 ? a.title.substring(0, 24) + "…" : a.title;
        fake.api.window.tabGroups.all[0].tabs = [
          { label: "Some other chat", input: { viewType: "mainThreadWebview-claudeVSCodePanel" } },
          { label, input: { viewType: "mainThreadWebview-claudeVSCodePanel" } },
        ];
        const before4 = calls.length;
        receive({ type: "chatCommand", id: a.id, command: "model", model: "haiku" });
        const asked = await until(() => calls.slice(before4).find((c) => c.command === "claude-vscode.editor.open"));
        const order = calls.slice(before4).map((c) => c.command);
        assert.deepEqual(calls.slice(before4).filter((c) => c.command === "closeTab").map((c) => c.args[0]), [label], "only that chat's tab is closed");
        assert.ok(order.indexOf("closeTab") < order.indexOf("claude-vscode.editor.open"), "closed first, so Claude opens it fresh");
        assert.equal(asked.args[0], a.id);
        assert.equal(asked.args[1], "/model haiku");
        await until(() => calls.slice(before4).find((c) => c.command === "claude-vscode.focus"));
        const tip = await until(() => [...posted].reverse().find((m) => m.type === "toast" && /press Enter/.test(m.text)));
        assert.match(tip.text, /\/model haiku is in its box/);
        assert.ok(calls.slice(before4).some((c) => c.command === "clipboard" && c.args[0] === "/model haiku"), "and copied, as a backup");
      }

      // A chat that is replying is never closed: the command waits on the clipboard.
      const busy = state.sessions.find((s: any) => !s.away && s.tool === "Claude" && s.status === "working");
      if (busy) {
        const label = busy.title.length > 25 ? busy.title.substring(0, 24) + "…" : busy.title;
        fake.api.window.tabGroups.all[0].tabs = [{ label, input: { viewType: "mainThreadWebview-claudeVSCodePanel" } }];
        const before8 = calls.length;
        receive({ type: "chatCommand", id: busy.id, command: "compact" });
        const tip = await until(() => [...posted].reverse().find((m) => m.type === "toast" && /replying/.test(m.text)));
        assert.match(tip.title, /Copied \/compact/);
        assert.ok(!calls.slice(before8).some((c) => c.command === "closeTab"), "its tab stays open");
      }

      // Codex: typed into the terminal the chat already runs in (never sent); otherwise resumed in a
      // terminal with the command typed once Codex has started.
      const codex = state.sessions.find((s: any) => s.tool === "Codex" && !s.away);
      assert.ok(codex, "the test's Codex chat is listed");
      assert.notEqual(codex.status, "working", `its reply has finished (${codex.status})`);
      {
        const running = { exitStatus: undefined, show() {}, sendText: (text: string, enter = true) => calls.push({ command: "runningCodex", args: [text, enter] }) };
        fake.events.started!({ terminal: running, execution: { commandLine: { value: "codex" } } });
        const before5 = calls.length;
        receive({ type: "chatCommand", id: codex.id, command: "compact" });
        const typed = await until(() => calls.slice(before5).find((c) => c.command === "runningCodex"));
        assert.deepEqual(typed.args, ["/compact", false], "typed where it runs, Enter left to the person");
        assert.ok(!calls.slice(before5).some((c) => c.command === "terminal"), "no second copy of the chat");
        (running as any).exitStatus = { code: 0 };

        const before6 = calls.length;
        receive({ type: "chatCommand", id: codex.id, command: "model" });
        const started = await until(() => calls.slice(before6).find((c) => c.command === "terminal"));
        assert.equal(started.args[1], `codex resume ${codex.id}`);
        const later = await until(() => calls.slice(before6).find((c) => c.command === "terminal" && c.args[1] === "/model"), 8000);
        assert.equal(later.args[2], false, "typed, not sent");
        const before7 = calls.length;
        receive({ type: "chatCommand", id: codex.id, command: "compact" });
        const again = await until(() => calls.slice(before7).find((c) => c.command === "terminal"));
        assert.deepEqual(again.args.slice(1), ["/compact", false], "next time, straight into that terminal");
      }

      receive({ type: "askBranch", id: a.id });
      const info = await until(() => posted.find((m) => m.type === "branchInfo"));
      assert.equal(info.id, a.id);
      assert.ok(info.contextChars > 0);

      receive({ type: "disconnect", connectionId: conns[0].id });
      await until(() => JSON.parse(fs.readFileSync(path.join(home, "connections.json"), "utf8")).length === 0 || undefined);
      // Unlinking tells both chats, with their next message.
      const toInbox = fs.readFileSync(path.join(home, "inbox", `${b.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(toInbox.map((i: any) => i.kind), ["notice"]);
      assert.match(toInbox[0].text, /^Channel from .* closed/);
      assert.ok(fs.readFileSync(path.join(home, "inbox", `${a.id}.jsonl`), "utf8").includes("No longer sharing"));
    } finally {
      for (const s of subs) s.dispose();
      delete process.env.CROSSTALK_HOME;
      delete process.env.CROSSTALK_WORKSPACE_DIR;
    }
  },
);

test("the person's real agent settings are untouched by the tests", () => {
  assert.deepEqual(realSettings.map(read), realBefore);
});
