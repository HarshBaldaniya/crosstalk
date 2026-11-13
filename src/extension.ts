import * as vscode from "vscode";
import { Controller } from "./vscode/controller";
import { CodeMapService } from "./vscode/codemap-service";
import { BackupService } from "./vscode/backup-service";
import { RunsService } from "./vscode/runs-service";
import { RUNS_OFFERED } from "./core/offered";

export function activate(ctx: vscode.ExtensionContext): void {
  const controller = new Controller(ctx);
  ctx.subscriptions.push(controller);
  const codeMap = new CodeMapService();
  ctx.subscriptions.push(codeMap);
  controller.useCodeMaps(codeMap);
  // Runs are not offered yet: nothing of them starts, watches or shows.
  const runs = RUNS_OFFERED ? new RunsService(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) : undefined;
  if (runs) {
    ctx.subscriptions.push(runs);
    controller.useRuns(runs);
    ctx.subscriptions.push(
      vscode.commands.registerCommand("crosstalk.openRuns", () => controller.openBoard("runs")),
      vscode.commands.registerCommand("crosstalk.stopAll", () => runs.stopAll()),
    );
  }
  const backup = new BackupService();
  ctx.subscriptions.push(backup);
  const offer = setTimeout(() => void controller.offerSetupOnce().catch(() => undefined), 3000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(offer) });

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "crosstalk.chats",
      {
        resolveWebviewView(view) {
          const detach = controller.attach(view.webview, "sidebar");
          view.onDidDispose(() => detach.dispose());
          view.onDidChangeVisibility(() => view.visible && controller.refreshSoon(0));
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("crosstalk.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("crosstalk.openBoard", () => controller.openBoard("board")),
    vscode.commands.registerCommand("crosstalk.openUsage", () => controller.openBoard("usage")),
    vscode.commands.registerCommand("crosstalk.openCode", () => controller.openBoard("code")),
    vscode.commands.registerCommand("crosstalk.openLibrary", () => controller.openBoard("library")),
    vscode.commands.registerCommand("crosstalk.newChat", () => controller.newChatCommand()),
    vscode.commands.registerCommand("crosstalk.connect", () => controller.turnOn()),
    vscode.commands.registerCommand("crosstalk.disconnect", () => controller.turnOff()),
    vscode.commands.registerCommand("crosstalk.addNotesTools", () => controller.addNotesTools()),
    vscode.commands.registerCommand("crosstalk.setUpToolkit", () => controller.setUpToolkit()),
    vscode.commands.registerCommand("crosstalk.removeToolkit", () => controller.removeToolkit()),
    vscode.commands.registerCommand("crosstalk.rebuildCodeMap", () => codeMap.rebuild()),
    vscode.commands.registerCommand("crosstalk.moduleDocs", () => codeMap.moduleDocs()),
    vscode.commands.registerCommand("crosstalk.backUp", () => backup.backUpNow()),
    vscode.commands.registerCommand("crosstalk.restore", () => backup.restoreNow()),
  );
}

export function deactivate(): void {}
