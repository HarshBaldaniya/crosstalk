// Runs and automations inside VS Code: starts runs, watches for the triggers automations wait on
// (a chat finishing, a schedule, a saved file, CI failing), and tells the pages when anything changes.
import * as path from "node:path";
import * as vscode from "vscode";
import { audit, decide, isPaused, listAutomations, readAudit, saveAutomations, setPaused, TEMPLATES, type Automation, type TriggerEvent } from "../core/automations";
import { findCommand } from "../core/hooks";
import { listHeads, readAsks } from "../core/record";
import { applyRun, discardRun, leaseConflicts, listRuns, realExec, runLog, startRun, stopAllRuns, stopRun, type RunAgent, type RunBudget } from "../core/runs";
import type { RunsView } from "../core/protocol";

const QUIET_MS = 20_000;

export class RunsService implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private timers: NodeJS.Timeout[] = [];
  /** A chat's last update, and whether it was already reported as finished */
  private seen = new Map<string, { at: number; fired: boolean }>();
  private ciSeen = new Set<string>();
  private lastMinute = -1;
  private listeners = new Set<() => void>();

  constructor(private readonly rootOf: () => string | undefined) {
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((d) => void this.fire({ kind: "file-saved", file: d.uri.fsPath })));
    this.timers.push(setInterval(() => this.watchChats(), 10_000));
    this.timers.push(setInterval(() => this.watchClock(), 15_000));
    this.timers.push(setInterval(() => void this.watchCi(), 5 * 60_000));
    // Chats that finished before VS Code opened don't count.
    for (const h of listHeads()) this.seen.set(h.id, { at: h.updatedAt, fired: true });
  }

  onChange(fn: () => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  view(): RunsView {
    const root = this.rootOf();
    return {
      runs: listRuns(root).slice(0, 60),
      automations: listAutomations().filter((a) => !root || path.resolve(a.root) === path.resolve(root)),
      paused: isPaused(),
      templates: TEMPLATES.map((t, i) => ({ index: i, name: t.name, kind: t.on.kind, agent: t.agent })),
      audit: readAudit(40).reverse(),
    };
  }

  private resolve = (agent: RunAgent) => findCommand(agent);

  async start(task: string, agents: RunAgent[], budget: Partial<RunBudget>, leases: string[], trigger = "you", hop = 0): Promise<string[]> {
    const root = this.rootOf();
    if (!root) throw new Error("Open a folder first.");
    const conflicts = leaseConflicts(leases, root);
    if (conflicts.length && trigger === "you") {
      const go = await vscode.window.showWarningMessage(
        `${conflicts.length} run${conflicts.length === 1 ? " is" : "s are"} already changing ${conflicts.flatMap((c) => c.folders).slice(0, 3).join(", ")}. Start anyway?`,
        { modal: true, detail: conflicts.map((c) => `“${c.run.task.slice(0, 60)}” (${c.run.agent})`).join("\n") },
        "Start anyway",
      );
      if (go !== "Start anyway") return [];
    }
    const group = agents.length > 1 ? `g${Date.now().toString(36)}` : undefined;
    const ids: string[] = [];
    for (const agent of agents) {
      if (!this.resolve(agent)) {
        void vscode.window.showWarningMessage(`${agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Gemini CLI"}'s command isn't on this computer, so that run didn't start.`);
        continue;
      }
      const run = await startRun({ task, agent, root, budget, leases, trigger, hop, group }, { resolve: this.resolve, onChange: () => this.changed() });
      ids.push(run.id);
    }
    this.changed();
    return ids;
  }

  async stop(id: string) {
    await stopRun(id);
    this.changed();
  }

  async stopAll(): Promise<void> {
    setPaused(true);
    const n = await stopAllRuns();
    this.changed();
    void vscode.window.showInformationMessage(`Stopped ${n} run${n === 1 ? "" : "s"} and paused every automation. Turn automations back on from the Runs page.`);
  }

  async apply(id: string) {
    const r = await applyRun(id);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showWarningMessage(r.message));
    this.changed();
  }

  async discard(id: string) {
    const ok = await vscode.window.showWarningMessage("Discard this run's changes? Its copy and branch are removed; its log stays.", { modal: true }, "Discard");
    if (ok !== "Discard") return;
    await discardRun(id);
    this.changed();
  }

  openLog(id: string) {
    void vscode.window.showTextDocument(vscode.Uri.file(runLog(id)));
  }

  openCopy(worktree: string) {
    void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktree), { forceNewWindow: true });
  }

  // ---- automations

  addTemplate(index: number) {
    const root = this.rootOf();
    const t = TEMPLATES[index];
    if (!root || !t) return;
    const list = listAutomations();
    list.push({ ...t, id: `a${Date.now().toString(36)}`, root, enabled: true });
    saveAutomations(list);
    this.changed();
  }

  update(id: string, change: Partial<Pick<Automation, "enabled" | "dailyCap">> | "remove") {
    let list = listAutomations();
    list = change === "remove" ? list.filter((a) => a.id !== id) : list.map((a) => (a.id === id ? { ...a, ...change } : a));
    saveAutomations(list);
    this.changed();
  }

  setPaused(paused: boolean) {
    setPaused(paused);
    this.changed();
  }

  /** Something happened: every automation that matches and passes every rail starts a run. */
  private async fire(e: TriggerEvent) {
    for (const a of listAutomations()) {
      const d = decide(a, e);
      if (!d.start) {
        if (d.why !== "doesn't match" && d.why !== "switched off") audit({ at: Date.now(), automation: a.id, event: e.kind, decision: "skipped", why: d.why, key: d.key });
        continue;
      }
      if (leaseConflicts(a.leases, a.root).length) {
        audit({ at: Date.now(), automation: a.id, event: e.kind, decision: "skipped", why: "another run is changing the same folders", key: d.key });
        continue;
      }
      try {
        const run = await startRun({ task: d.task!, agent: a.agent, root: a.root, budget: a.budget, leases: a.leases, trigger: a.name, hop: 1 }, { resolve: this.resolve, onChange: () => this.changed() });
        audit({ at: Date.now(), automation: a.id, event: e.kind, decision: "started", run: run.id, key: d.key });
        void vscode.window.showInformationMessage(`Automation started a run: ${a.name}. Its result waits for you on the Runs page.`);
      } catch (err) {
        audit({ at: Date.now(), automation: a.id, event: e.kind, decision: "skipped", why: err instanceof Error ? err.message : String(err), key: d.key });
      }
      this.changed();
    }
  }

  /** A chat counts as finished once its session log has been quiet for a while after changing. */
  private watchChats() {
    if (!listAutomations().some((a) => a.enabled && a.on.kind === "chat-finished")) return;
    const now = Date.now();
    for (const h of listHeads()) {
      const s = this.seen.get(h.id);
      if (!s || h.updatedAt > s.at) {
        this.seen.set(h.id, { at: h.updatedAt, fired: false });
        continue;
      }
      if (!s.fired && now - s.at > QUIET_MS) {
        s.fired = true;
        const last = readAsks(h.id, 1)[0];
        void this.fire({ kind: "chat-finished", cwd: h.cwd, chat: h.title ?? h.goal ?? h.id.slice(0, 8), did: last?.did });
      }
    }
  }

  private watchClock() {
    const d = new Date();
    const minute = d.getHours() * 60 + d.getMinutes();
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    if (listAutomations().some((a) => a.enabled && a.on.kind === "schedule")) void this.fire({ kind: "schedule", at: d.getTime() });
  }

  /** CI on this branch, through GitHub's own `gh`: a new failed run is an event, once. */
  private async watchCi() {
    const root = this.rootOf();
    if (!root || !listAutomations().some((a) => a.enabled && a.on.kind === "ci-failed")) return;
    const gh = findCommand("gh");
    if (!gh) return;
    const branch = (await realExec("git", ["branch", "--show-current"], root)).out.trim();
    if (!branch) return;
    const list = await realExec(gh, ["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId,conclusion,status"], root);
    try {
      const [run] = JSON.parse(list.out) as { databaseId: number; conclusion: string; status: string }[];
      if (!run || run.status !== "completed" || run.conclusion !== "failure" || this.ciSeen.has(String(run.databaseId))) return;
      this.ciSeen.add(String(run.databaseId));
      const log = (await realExec(gh, ["run", "view", String(run.databaseId), "--log-failed"], root)).out;
      void this.fire({ kind: "ci-failed", cwd: root, log });
    } catch {
      // gh not signed in, or no runs: nothing to do.
    }
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    for (const d of this.disposables) d.dispose();
  }
}
