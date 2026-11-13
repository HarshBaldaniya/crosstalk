import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** Crosstalk's own folder: the hook, the MCP server, connections, inboxes and live status. */
export function crosstalkHome(): string {
  return process.env.CROSSTALK_HOME || path.join(os.homedir(), ".crosstalk");
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

export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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
