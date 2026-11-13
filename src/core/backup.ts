// Backing up what only lives on this computer: the session logs (every chat's asks and outcomes), the
// person's own Library commands, and which chats are linked. The code map is not backed up: it is
// rebuilt from the code in seconds. Copies only what changed, never deletes from the backup.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { crosstalkHome } from "./paths";

/** What is worth keeping: personal, and impossible to rebuild. */
const ITEMS = ["flightlogs", "library", "connections.json", "deliveries.jsonl"];

const machine = () => os.hostname().replace(/\.local$/, "").replace(/[^A-Za-z0-9_-]/g, "_") || "this-computer";

export function backupDirFor(folder: string): string {
  return path.join(folder, "crosstalk-backup", machine());
}

function walk(src: string, fn: (rel: string, full: string, st: fs.Stats) => void, rel = "") {
  let st: fs.Stats;
  try {
    st = fs.statSync(src);
  } catch {
    return;
  }
  if (st.isFile()) return fn(rel, src, st);
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(src)) walk(path.join(src, name), fn, rel ? path.join(rel, name) : name);
}

/** Copies every new or changed file to `<folder>/crosstalk-backup/<this computer>/`. */
export function backUp(folder: string): { copied: number; files: number; to: string } {
  const to = backupDirFor(folder);
  let copied = 0;
  let files = 0;
  for (const item of ITEMS) {
    walk(path.join(crosstalkHome(), item), (rel, full, st) => {
      files++;
      const dest = path.join(to, item, rel);
      try {
        const d = fs.statSync(dest);
        if (d.size === st.size && Math.abs(d.mtimeMs - st.mtimeMs) < 1000) return;
      } catch {
        // Not backed up yet.
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      fs.utimesSync(dest, st.atime, st.mtime);
      copied++;
    });
  }
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, "README.txt"), `Crosstalk's session logs from ${machine()}, last backed up ${new Date().toISOString()}.\nRestore with "Crosstalk: Restore session logs" or: node ~/.crosstalk/crosstalk.js restore "${folder}"\n`);
  return { copied, files, to };
}

/**
 * Brings back what this computer is missing from every computer's backup in the folder: a file that
 * isn't here, or is shorter here (session logs only ever grow), is copied in. Nothing is overwritten
 * with something older or shorter.
 */
export function restore(folder: string): { restored: number; from: string[] } {
  const root = path.join(folder, "crosstalk-backup");
  let machines: string[] = [];
  try {
    machines = fs.readdirSync(root).filter((m) => fs.statSync(path.join(root, m)).isDirectory());
  } catch {
    return { restored: 0, from: [] };
  }
  let restored = 0;
  for (const m of machines) {
    for (const item of ITEMS) {
      walk(path.join(root, m, item), (rel, full, st) => {
        const dest = path.join(crosstalkHome(), item, rel);
        try {
          const d = fs.statSync(dest);
          if (d.size >= st.size) return;
        } catch {
          // Missing here: restore it.
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        restored++;
      });
    }
  }
  return { restored, from: machines };
}
