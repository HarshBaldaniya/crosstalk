import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** Crosstalk's own folder: the hook, the MCP server, connections, inboxes and live status. */
export function crosstalkHome(): string {
  const home = process.env.CROSSTALK_HOME || path.join(os.homedir(), ".crosstalk");
  if (!locked.has(home)) {
    locked.add(home);
    lockDown(home);
  }
  return home;
}

const locked = new Set<string>();

/** Flightlogs and inboxes hold what people typed to their agents, so the folder is the person's
 *  alone (0700): other accounts on the computer can't list or read anything inside it. */
function lockDown(dir: string): void {
  if (process.platform === "win32") return; // A Windows profile folder is already private to its user.
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  } catch {
    // A read-only home: nothing will be written there either.
  }
}

export function crosstalkFile(...parts: string[]): string {
  return path.join(crosstalkHome(), ...parts);
}

export function statusDir(): string {
  return crosstalkFile("status");
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Claude Code keeps one folder per project under ~/.claude/projects. */
export function claudeProjectsDir(): string {
  return path.join(claudeHome(), "projects");
}

/** Claude Code names a project's folder after its path, every character that is not a letter or digit as "-". */
export function claudeProjectFolder(cwd: string): string {
  return path.join(claudeProjectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The saved history of one Claude chat, wherever it lives. */
export function findClaudeTranscript(sessionId: string, cwd?: string): string | undefined {
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(claudeProjectFolder(cwd), file);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    for (const dir of fs.readdirSync(claudeProjectsDir())) {
      const candidate = path.join(claudeProjectsDir(), dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No ~/.claude/projects yet.
  }
  return undefined;
}

export function codexSessionsDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

export function geminiTmpDir(): string {
  return process.env.CROSSTALK_GEMINI_TMP || path.join(os.homedir(), ".gemini", "tmp");
}

/** The workspace's `.crosstalk/` folder (tests point it elsewhere with CROSSTALK_WORKSPACE_DIR). */
export function workspaceCrosstalkPath(root: string): string {
  return process.env.CROSSTALK_WORKSPACE_DIR || path.join(root, ".crosstalk");
}

/** The workspace's `.crosstalk/` folder, made on first use and kept out of git. */
export function workspaceCrosstalkDir(root: string): string {
  const dir = workspaceCrosstalkPath(root);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
  }
  return dir;
}

/** The person's real agent folders. Under `node --test` nothing may change them: every test points
 *  them at temporary folders, and this stops one that forgot (or ran too early) instead of letting it
 *  rewrite someone's Claude Code, Codex or Gemini CLI settings. */
export function guardRealHome(file: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const f = path.resolve(file);
  for (const d of [".claude", ".claude.json", ".codex", ".gemini", ".agents", ".crosstalk"]) {
    const real = path.join(os.homedir(), d);
    if (f === real || f.startsWith(real + path.sep)) throw new Error(`A test tried to change ${real}. Point it at a temporary folder.`);
  }
}

/**
 * Replaces a file in one step, so a crash never leaves half of it. The file keeps its own
 * permissions (a 0600 ~/.claude.json stays 0600), a new file is the person's alone (0600), and a
 * dotfile that is a symlink is written where it points instead of being replaced by a copy. The
 * temporary file has a name nobody can guess and is never opened if something is already there.
 */
export function writeFileAtomic(file: string, text: string): void {
  guardRealHome(file);
  try {
    file = fs.realpathSync(file);
  } catch {
    // A new file.
  }
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // A new file: private.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: mode ?? 0o600, flag: "wx" });
    if (mode !== undefined && process.platform !== "win32") fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Ids from tools are used as file names: only plain ones are accepted. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
