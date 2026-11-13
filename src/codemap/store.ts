// Where a codebase's map is kept: ~/.crosstalk/codemap/<folder-id>/, never in the repo.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFile } from "node:child_process";
import { crosstalkFile, writeFileAtomic } from "../core/paths";
import type { Decl, Import } from "./extract";
import { langOf, type LangId } from "./parser";
import { TABLE_SKIP_DIR } from "./langs";

export interface FileEntry {
  /** Path from the root, with forward slashes */
  p: string;
  l: LangId;
  /** Content hash (first 16 hex of SHA-1), size and modified time when it was read */
  h: string;
  z: number;
  m: number;
  /** Lines */
  n: number;
  d: Decl[];
  i: Import[];
  /** What `export default` names */
  def?: string;
}

/** A store's format; a change here rebuilds every map once. */
export const STORE_VERSION = 1;

export function folderId(root: string): string {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // A folder that is gone still has an id.
  }
  const hash = crypto.createHash("sha1").update(real).digest("hex").slice(0, 10);
  return `${path.basename(real).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${hash}`;
}

export function storeDir(root: string): string {
  return crosstalkFile("codemap", folderId(root));
}

const filesPath = (root: string) => path.join(storeDir(root), "files.jsonl.gz");
const metaPath = (root: string) => path.join(storeDir(root), "meta.json");

export interface StoreMeta {
  v: number;
  root: string;
  builtAt: number;
  files: number;
  bytes: number;
}

export function loadEntries(root: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(root), "utf8")) as StoreMeta;
    if (meta.v !== STORE_VERSION) return out;
    const text = zlib.gunzipSync(fs.readFileSync(filesPath(root))).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as FileEntry;
        out.set(e.p, e);
      } catch {
        // A torn line is re-read from the file on the next sweep.
      }
    }
  } catch {
    // No map yet.
  }
  return out;
}

export function saveEntries(root: string, entries: Iterable<FileEntry>): StoreMeta {
  const lines: string[] = [];
  let files = 0;
  for (const e of entries) {
    lines.push(JSON.stringify(e));
    files++;
  }
  const gz = zlib.gzipSync(lines.join("\n"), { level: 6 });
  fs.mkdirSync(storeDir(root), { recursive: true });
  const tmp = `${filesPath(root)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, filesPath(root));
  const meta: StoreMeta = { v: STORE_VERSION, root, builtAt: Date.now(), files, bytes: gz.length };
  writeFileAtomic(metaPath(root), JSON.stringify(meta));
  return meta;
}

export function readMeta(root: string): StoreMeta | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(root), "utf8")) as StoreMeta;
    return meta.v === STORE_VERSION ? meta : undefined;
  } catch {
    return undefined;
  }
}

export function contentHash(text: string | Buffer): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- which files

/** Folders never mapped, whatever .gitignore says. */
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vercel|\.cache|dist|build|out|out-test|coverage|vendor|venv|\.venv|env|__pycache__|\.mypy_cache|\.pytest_cache|\.tox|site-packages|bower_components|\.crosstalk|\.context|\.claude|\.codex|\.gemini|storybook-static|playwright-report|test-results)(\/|$)/;
/** Files that are generated or minified: bulk without meaning. */
const SKIP_FILE = /(\.min\.(js|mjs|cjs)|\.bundle\.js|\.chunk\.js|-lock\.json|\.map|\.generated\.(ts|js)|\.gen\.(ts|js)|_pb2(_grpc)?\.py)$/;
/** Bigger than this is data or generated code, not something to read for meaning. */
export const MAX_FILE_BYTES = 512 * 1024;

export function mappable(rel: string): boolean {
  return !!langOf(rel) && !SKIP_DIR.test(rel) && !TABLE_SKIP_DIR.test(rel) && !SKIP_FILE.test(rel);
}

/** Every file of the codebase worth mapping: git's list when it's a repo (respects .gitignore), else a walk. */
export async function listFiles(root: string): Promise<string[]> {
  const fromGit = await new Promise<string[] | undefined>((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout.split("\0").filter(Boolean)),
    );
  });
  if (fromGit) return [...new Set(fromGit)].filter(mappable).sort();
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 20 || out.length > 50_000) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (!SKIP_DIR.test(`${r}/`) && !it.name.startsWith(".")) walk(path.join(dir, it.name), r, depth + 1);
      } else if (it.isFile() && mappable(r)) out.push(r);
    }
  };
  walk(root, "", 0);
  return out.sort();
}
