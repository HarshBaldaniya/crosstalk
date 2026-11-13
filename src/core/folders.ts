// Which chats from other folders the views show.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatSession, Tool } from "./types";
import { readJson, crosstalkFile, writeFileAtomic } from "./paths";

export const ELSEWHERE_PER_FOLDER = 15;
export const ELSEWHERE_FOLDERS = 25;

/**
 * Chats from other folders worth showing: the newest few of each folder, from the most recent
 * folders, so one busy folder can't crowd out the rest. Chats in `keep` always stay.
 */
export function pickElsewhere(list: ChatSession[], keep: Set<string>, perFolder = ELSEWHERE_PER_FOLDER, folders = ELSEWHERE_FOLDERS): ChatSession[] {
  const byFolder = new Map<string, ChatSession[]>();
  const out: ChatSession[] = [];
  for (const s of [...list].sort((a, b) => b.lastModified - a.lastModified)) {
    if (keep.has(s.id)) {
      out.push(s);
      continue;
    }
    const key = path.resolve(s.cwd ?? "");
    if (!byFolder.has(key) && byFolder.size >= folders) continue;
    const kept = byFolder.get(key) ?? [];
    if (kept.length >= perFolder) continue;
    kept.push(s);
    byFolder.set(key, kept);
    out.push(s);
  }
  return out;
}

// Each as written and as it really is (on macOS /var and /tmp are links into /private).
const TEMP_ROOTS = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].flatMap((p) => {
  try {
    return [path.resolve(p), fs.realpathSync(p)];
  } catch {
    return [path.resolve(p)];
  }
});

/** A throwaway folder (the system's temp space): its chats are left out of "All folders". */
export function isTempFolder(p: string): boolean {
  let real = path.resolve(p);
  try {
    real = fs.realpathSync(p);
  } catch {
    // Gone: judged by its name.
  }
  return [path.resolve(p), real].some((x) => TEMP_ROOTS.some((t) => x === t || x.startsWith(t + path.sep)));
}

// ---- opening a chat in its own folder's window ----


/**
 * A chat to open in its own folder's VS Code window: the window that has (or opens) that folder
 * takes the request and opens the chat there.
 */
export interface OpenRequest {
  id: string;
  tool: Tool;
  cwd: string;
  at: number;
  /** For the terminal's name, so the other window needn't list its chats first. */
  title?: string;
}

const OPEN_FRESH_MS = 2 * 60_000;
const openFile = () => crosstalkFile("open-requests.json");

export function addOpenRequest(r: OpenRequest): void {
  const kept = readJson<OpenRequest[]>(openFile(), []).filter((x) => r.at - x.at < OPEN_FRESH_MS && x.id !== r.id);
  writeFileAtomic(openFile(), JSON.stringify([...kept, r]));
}

/** A folder as the file system sees it: a symlinked or differently spelled path matches its target. */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

/**
 * The requests for this window (any of its folders), taken so no other window acts on them;
 * stale ones are dropped.
 */
export function takeOpenRequests(roots: string | string[], now = Date.now(), which: (r: OpenRequest) => boolean = () => true): OpenRequest[] {
  const all = readJson<OpenRequest[]>(openFile(), []);
  if (!all.length) return [];
  const mine = (x: OpenRequest) => which(x) && (Array.isArray(roots) ? roots : [roots]).some((r) => samePath(x.cwd, r));
  const fresh = all.filter((x) => now - x.at < OPEN_FRESH_MS);
  const taken = fresh.filter(mine);
  const rest = fresh.filter((x) => !mine(x));
  if (taken.length || rest.length !== all.length) writeFileAtomic(openFile(), JSON.stringify(rest));
  return taken;
}

/** Whether a request is still waiting for its window. */
export function openRequestWaiting(id: string): boolean {
  return readJson<OpenRequest[]>(openFile(), []).some((x) => x.id === id);
}

/** Withdraws a request no window has taken; true when it was still waiting. */
export function dropOpenRequest(id: string): boolean {
  const all = readJson<OpenRequest[]>(openFile(), []);
  const rest = all.filter((x) => x.id !== id);
  if (rest.length === all.length) return false;
  writeFileAtomic(openFile(), JSON.stringify(rest));
  return true;
}
