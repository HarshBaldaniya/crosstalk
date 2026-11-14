// Notes: plain Markdown any AI tool can leave for another, through the MCP
// server. Kept in the workspace's `.crosstalk/notes/` (git-ignored by default).
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceCrosstalkDir, workspaceCrosstalkPath, writeFileAtomic } from "./paths";

/** Largest note read back (a note is a hand-over, not a dump). */
const NOTE_MAX = 256 * 1024;

/** The notes folder, only when it really is inside the project. A cloned repo could commit
 *  `.crosstalk` or `.crosstalk/notes` as a symlink to somewhere private (~/.ssh); that is refused. */
function notesDir(root: string): string | undefined {
  const dir = path.join(workspaceCrosstalkPath(root), "notes");
  try {
    const real = fs.realpathSync(dir);
    if (process.env.CROSSTALK_WORKSPACE_DIR) return real;
    const base = fs.realpathSync(root);
    return real === base || real.startsWith(base + path.sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** One note's text, or undefined when there is no such note. Only a plain file, inside the notes
 *  folder after following every link, and not larger than NOTE_MAX: a symlink to a private file,
 *  a FIFO or /dev/zero planted in a repo is refused. */
export function readNote(root: string, name: string): string | undefined {
  const base = notesDir(root);
  if (!base) return undefined;
  const asked = path.resolve(path.dirname(base), name);
  try {
    const real = fs.realpathSync(asked);
    if (!real.startsWith(base + path.sep)) return undefined;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > NOTE_MAX) return undefined;
    return fs.readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

/** Saves a note under `.crosstalk/notes/` and returns its name relative to `.crosstalk/`. */
export function saveNote(root: string, title: string, text: string, now = new Date()): string {
  const dir = workspaceCrosstalkDir(root);
  if (!notesDir(root)) throw new Error("This project's .crosstalk/notes folder points outside the project, so no note was saved.");
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let name = `notes/${stamp}-${slug(title)}.md`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `notes/${stamp}-${slug(title)}-${n++}.md`;
  writeFileAtomic(path.join(dir, name), `${text}\n`);
  return name;
}

export function listNotes(root: string): { name: string; title: string; at: number }[] {
  const dir = notesDir(root);
  if (!dir) return [];
  const out: { name: string; title: string; at: number }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const full = path.join(dir, f);
    try {
      // Plain files only (no links, FIFOs or devices), and just the first line's worth of each.
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(Math.min(4096, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const first = buf.toString("utf8").split("\n", 1)[0] || f;
      out.push({ name: `notes/${f}`, title: first.replace(/^#\s*/, "").trim(), at: st.mtimeMs });
    } catch {
      // Gone or unreadable: leave it out.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "note"
  );
}
