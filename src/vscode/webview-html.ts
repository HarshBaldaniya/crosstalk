import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

/** The page every Crosstalk webview loads: the React bundle, told which view it is. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: "sidebar" | "board"): string {
  const nonce = randomBytes(16).toString("base64");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Crosstalk</title>
</head>
<body data-view="${view}">
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
