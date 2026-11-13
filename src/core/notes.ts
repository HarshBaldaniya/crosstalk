// Notes: plain Markdown any AI tool can leave for another, through the MCP
// server. Kept in the workspace's `.crosstalk/notes/` (git-ignored by default).
import * as fs from "node:fs";
import * as path from "node:path";
import { workspaceCrosstalkDir, workspaceCrosstalkPath, writeFileAtomic } from "./paths";

/** Saves a note under `.crosstalk/notes/` and returns its name relative to `.crosstalk/`. */
export function saveNote(root: string, title: string, text: string, now = new Date()): string {
  const dir = workspaceCrosstalkDir(root);
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let name = `notes/${stamp}-${slug(title)}.md`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `notes/${stamp}-${slug(title)}-${n++}.md`;
  writeFileAtomic(path.join(dir, name), `${text}\n`);
  return name;
}

export function listNotes(root: string): { name: string; title: string; at: number }[] {
  const dir = path.join(workspaceCrosstalkPath(root), "notes");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const full = path.join(dir, f);
      const first = fs.readFileSync(full, "utf8").split("\n", 1)[0] ?? f;
      return { name: `notes/${f}`, title: first.replace(/^#\s*/, "").trim(), at: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
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
