// Packages Crosstalk and installs it into VS Code, on macOS, Windows or Linux.
// VS Code's own command is used, never a `code` on the PATH that may belong to another editor.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const win = process.platform === "win32";
const candidates = process.env.CROSSTALK_VSCODE_CLI
  ? [process.env.CROSSTALK_VSCODE_CLI]
  : process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", join(home, "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")]
    : win
      ? [
          join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "bin", "code.cmd"),
        ]
      : ["/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code", "/opt/visual-studio-code/bin/code"];
const cli = candidates.find((c) => existsSync(c));
if (!cli) {
  console.error(`VS Code's command wasn't found. Looked in:\n  ${candidates.join("\n  ")}\nSet CROSSTALK_VSCODE_CLI to its path and run again.`);
  process.exit(1);
}
const run = (args) => execFileSync(win ? `"${cli}"` : cli, args, { stdio: "inherit", shell: win });

try {
  run(["--uninstall-extension", "relay-dev.relay"]);
} catch {
  // The old Relay isn't installed: nothing to remove.
}
run(["--install-extension", "crosstalk-0.0.1.vsix", "--force"]);
mkdirSync(join(home, ".crosstalk"), { recursive: true });
copyFileSync(join("dist", "crosstalk-hook.js"), join(home, ".crosstalk", "crosstalk-hook.js"));
console.log("Installed. Reload the VS Code window to use it.");
