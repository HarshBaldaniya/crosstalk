// Keeps each open folder's code map current: built in the background a few seconds after start,
// then only the files you save, create or delete are read again (about a second after you stop).
import * as path from "node:path";
import * as vscode from "vscode";
import { CodeMap, type CodeMapStats } from "../codemap/index";
import { openClaude } from "./open";

const SETTLE_MS = 800;
const START_DELAY_MS = 5000;
const GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py}";

export class CodeMapService implements vscode.Disposable {
  private maps = new Map<string, CodeMap>();
  private pending = new Map<string, Set<string>>();
  private timer?: NodeJS.Timeout;
  private startTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private lastStats = new Map<string, CodeMapStats>();
  private readonly log: vscode.OutputChannel;

  constructor() {
    this.log = vscode.window.createOutputChannel("Crosstalk code map");
    this.disposables.push(this.log);
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    const queue = (uri: vscode.Uri) => this.queue(uri.fsPath);
    watcher.onDidChange(queue);
    watcher.onDidCreate(queue);
    watcher.onDidDelete(queue);
    this.disposables.push(watcher);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.start(0)));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("crosstalk.codeMap")) this.start(0);
      }),
    );
    this.start(START_DELAY_MS);
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration("crosstalk").get<boolean>("codeMap.enabled", true);
  }

  private start(delay: number) {
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => void this.buildAll(), delay);
  }

  private async buildAll(full = false) {
    if (!this.enabled) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      const root = folder.uri.fsPath;
      let map = this.maps.get(root);
      if (!map) this.maps.set(root, (map = new CodeMap(root)));
      try {
        const stats = await map.refresh({ full });
        this.lastStats.set(root, stats);
        if (stats.parsed || stats.removed) {
          this.log.appendLine(
            `${new Date().toLocaleTimeString()} ${path.basename(root)}: ${stats.files} files, ${stats.decls} declarations; read ${stats.parsed}, ${stats.removed} gone, ${stats.ms} ms${stats.bytes ? `, ${(stats.bytes / 1024).toFixed(0)} KB` : ""}`,
          );
        }
      } catch (err) {
        this.log.appendLine(`${path.basename(root)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private queue(file: string) {
    if (!this.enabled) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
    if (!folder) return;
    const root = folder.uri.fsPath;
    let set = this.pending.get(root);
    if (!set) this.pending.set(root, (set = new Set()));
    set.add(file);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SETTLE_MS);
  }

  private async flush() {
    const batches = [...this.pending.entries()];
    this.pending.clear();
    for (const [root, files] of batches) {
      const map = this.maps.get(root);
      // Not built yet: the first build reads everything anyway.
      if (!map || !map.exists()) continue;
      try {
        const stats = await map.refresh({ changed: [...files] });
        this.lastStats.set(root, stats);
      } catch {
        // Tried again on the next save.
      }
    }
  }

  /** Reads every file again from scratch. */
  async rebuild(): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Crosstalk: building the code map" }, () => this.buildAll(true));
    const lines = [...this.lastStats.entries()].map(([root, s]) => `${path.basename(root)}: ${s.files} files, ${s.decls} declarations in ${(s.ms / 1000).toFixed(1)} s`);
    void vscode.window.showInformationMessage(`Code map ready. ${lines.join(" · ")}`);
  }

  /** Module docs: see which parts have one, draft one with an agent, review and approve. */
  async moduleDocs(): Promise<void> {
    const folder = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : vscode.workspace.workspaceFolders?.[0];
    if (!folder) return void vscode.window.showInformationMessage("Open a folder first.");
    const root = folder.uri.fsPath;
    let map = this.maps.get(root);
    if (!map) this.maps.set(root, (map = new CodeMap(root)));
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Crosstalk: reading the code map" }, () => map!.refresh());
    const items = map.modules().slice(0, 40).map((m) => {
      const d = map!.moduleDoc(m.id)!;
      const changed = d.status === "approved" && d.approvedCode !== d.currentCode;
      const description =
        d.status === "missing" ? "no doc" : d.status === "draft" ? "draft, ready to review" : changed ? `approved; code changed since${d.changedFiles !== undefined ? ` (${d.changedFiles} files)` : ""}` : `approved ${d.approvedOn ?? ""}`;
      const icon = d.status === "missing" ? "$(circle-large-outline)" : d.status === "draft" ? "$(edit)" : changed ? "$(warning)" : "$(pass-filled)";
      return { label: `${icon} ${m.id}`, description, detail: `${m.files.length} files${m.dependsOn.length ? ` · uses ${m.dependsOn.slice(0, 2).join(", ")}` : ""}`, id: m.id, doc: d };
    });
    const pick = await vscode.window.showQuickPick(items, { title: "Module docs: agents read only approved ones", placeHolder: "The code's main parts, most depended on first", matchOnDescription: true });
    if (!pick) return;
    const draftIt = "Draft it with Claude";
    const open = "Open it";
    const approve = pick.doc.status === "approved" ? "Approve again for today's code" : "Approve it";
    const actions = pick.doc.status === "missing" ? [draftIt, "Copy the command for another agent"] : [open, approve, "Draft it again"];
    const act = await vscode.window.showQuickPick(actions, { title: pick.id });
    const command = `/crosstalk:module-docs ${pick.id}`;
    if (act === draftIt || act === "Draft it again") return openClaude(undefined, command);
    if (act === "Copy the command for another agent") {
      await vscode.env.clipboard.writeText(`module-docs ${pick.id}`);
      return void vscode.window.showInformationMessage("Copied. In Codex run /prompts:module-docs, in Gemini /module-docs, with the module after it.");
    }
    if (act === open) return void vscode.window.showTextDocument(vscode.Uri.file(pick.doc.file));
    if (act === approve) {
      map.approveModuleDoc(pick.id);
      void vscode.window.showInformationMessage(`Approved. Agents now get it when they outline ${pick.id}. Commit docs/modules/ to share it with your team.`);
    }
  }

  mapFor(root: string): CodeMap | undefined {
    return this.maps.get(root);
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    for (const d of this.disposables) d.dispose();
  }
}
