// Backs up the session logs to a folder the person picks (iCloud Drive, OneDrive, Dropbox, a USB
// drive ...): a few minutes after start, then every half hour, copying only what changed.
import * as vscode from "vscode";
import { backUp, restore } from "../core/backup";

const EVERY_MS = 30 * 60_000;

export class BackupService implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor() {
    this.first = setTimeout(() => this.run(false), 3 * 60_000);
    this.timer = setInterval(() => this.run(false), EVERY_MS);
  }

  private get folder(): string {
    return vscode.workspace.getConfiguration("crosstalk").get<string>("backupFolder", "").trim();
  }

  private run(loud: boolean) {
    const folder = this.folder;
    if (!folder) return;
    try {
      const r = backUp(folder);
      if (loud) void vscode.window.showInformationMessage(`Backed up ${r.copied} new or changed files (of ${r.files}) to ${r.to}.`);
    } catch (err) {
      if (loud) void vscode.window.showErrorMessage(`Crosstalk couldn't back up to ${folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pickFolder(title: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title, openLabel: "Use this folder" });
    return picked?.[0]?.fsPath;
  }

  async backUpNow(): Promise<void> {
    let folder = this.folder;
    if (!folder) {
      folder = (await this.pickFolder("Back up Crosstalk's session logs to")) ?? "";
      if (!folder) return;
      await vscode.workspace.getConfiguration("crosstalk").update("backupFolder", folder, vscode.ConfigurationTarget.Global);
    }
    this.run(true);
  }

  async restoreNow(): Promise<void> {
    const folder = this.folder || (await this.pickFolder("Restore Crosstalk's session logs from"));
    if (!folder) return;
    const r = restore(folder);
    void vscode.window.showInformationMessage(r.from.length ? `Restored ${r.restored} files from ${r.from.join(", ")}. Nothing here was replaced.` : `No Crosstalk backup in ${folder}.`);
  }

  dispose(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
