// Crosstalk was called Relay. Its data moves to the new names once, on the first start:
//   ~/.relay            → ~/.crosstalk     (links, inboxes, status, flightlogs, settings)
//   <project>/.relay    → <project>/.crosstalk  (the Tower's layout, notes)
//   sessions/           → flightlogs/
// A window still running the old version may write to the old folder until it is reloaded, so
// both can exist: whatever the new folder doesn't have yet moves in, and the old folder goes.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Files the old version wrote that the new one makes afresh (its own hook and tool server). */
const OLD_ONLY = new Set(["relay-hook.js", "relay-mcp.js"]);
const RENAMED: Record<string, string> = { sessions: "flightlogs" };

/** Moves one folder's contents into another, keeping whatever the new one already has. */
function merge(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(from)) {
    if (OLD_ONLY.has(name)) continue;
    const src = path.join(from, name);
    const dest = path.join(to, RENAMED[name] ?? name);
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
      moved++;
    } else if (fs.statSync(src).isDirectory() && fs.statSync(dest).isDirectory()) {
      moved += merge(src, dest);
    }
    // A file both have: the new folder's copy is newer (written by this version), so it stays.
  }
  fs.rmSync(from, { recursive: true, force: true });
  return moved;
}

/** ~/.relay into Crosstalk's home. Returns how many things moved. */
export function moveOldHome(home: string, old = path.join(os.homedir(), ".relay")): number {
  try {
    const moved = merge(old, home);
    // Records kept under their old folder name inside the new home, too.
    if (fs.existsSync(path.join(home, "sessions"))) merge(path.join(home, "sessions"), path.join(home, "flightlogs"));
    return moved;
  } catch {
    // Left for the next start.
    return 0;
  }
}

/** <project>/.relay into <project>/.crosstalk. */
export function moveOldWorkspace(root: string, to: string): number {
  try {
    return merge(path.join(root, ".relay"), to);
  } catch {
    return 0;
  }
}
