// Module docs: short notes on what code can't say (why a part is built this way, what not to touch,
// how to test it). An agent drafts them; a person approves them; only approved ones reach agents.
// They live in the repo (docs/modules/<module>.md), so teammates, reviewers and cloud agents share
// them. Each carries a fingerprint of the code it describes: when that code moves on, the doc says
// so, and any line naming code that no longer exists is held back rather than served as fact.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "./modules";
import type { FileEntry } from "./store";

export type DocStatus = "missing" | "draft" | "approved";

export interface ModuleDoc {
  module: string;
  file: string;
  status: DocStatus;
  /** The code's fingerprint when it was approved, and now */
  approvedCode?: string;
  currentCode: string;
  approvedOn?: string;
  /** Files whose content differs from when it was approved, when this computer knows */
  changedFiles?: number;
  body: string;
}

export const MODULE_DOCS_DIR = path.join("docs", "modules");
/** About 40 lines: what fits on a screen, and is read whole. */
export const MAX_DOC_LINES = 60;

export function docSlug(moduleId: string): string {
  return moduleId.replace(/^\.\/?/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "root";
}

export function docPath(root: string, moduleId: string): string {
  return path.join(root, MODULE_DOCS_DIR, `${docSlug(moduleId)}.md`);
}

/** One fingerprint for a module's code: its files' paths and content hashes. */
export function codeFingerprint(module: Module, files: Map<string, FileEntry>): string {
  const h = crypto.createHash("sha1");
  for (const p of [...module.files].sort()) h.update(`${p}\0${files.get(p)?.h ?? ""}\n`);
  return h.digest("hex").slice(0, 16);
}

interface Head {
  module?: string;
  status?: string;
  code?: string;
  approved?: string;
}

export function parseDoc(text: string): { head: Head; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { head: {}, body: text.trim() };
  const head: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { head, body: m[2].trim() };
}

function render(head: Head, body: string): string {
  const lines = [`module: ${head.module}`, `status: ${head.status}`];
  if (head.code) lines.push(`code: ${head.code}`);
  if (head.approved) lines.push(`approved: ${head.approved}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** Per-file hashes at approval, kept on this computer, so "which files changed" can be told. */
function snapshotPath(storeDir: string): string {
  return path.join(storeDir, "moduledocs.json");
}

function readSnapshots(storeDir: string): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(storeDir), "utf8"));
  } catch {
    return {};
  }
}

export function readModuleDoc(root: string, module: Module, files: Map<string, FileEntry>, storeDir: string): ModuleDoc {
  const file = docPath(root, module.id);
  const currentCode = codeFingerprint(module, files);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { module: module.id, file, status: "missing", currentCode, body: "" };
  }
  const { head, body } = parseDoc(text);
  const status: DocStatus = head.status === "approved" ? "approved" : "draft";
  const doc: ModuleDoc = { module: module.id, file, status, approvedCode: head.code, currentCode, approvedOn: head.approved, body };
  if (status === "approved" && head.code && head.code !== currentCode) {
    const snap = readSnapshots(storeDir)[module.id];
    if (snap) {
      let changed = 0;
      for (const p of module.files) if (snap[p] !== files.get(p)?.h) changed++;
      for (const p of Object.keys(snap)) if (!module.files.includes(p)) changed++;
      doc.changedFiles = changed;
    }
  }
  return doc;
}

/** Marks a draft approved, stamped with the code it describes as it is now. */
export function approveModuleDoc(root: string, module: Module, files: Map<string, FileEntry>, storeDir: string, today = new Date()): ModuleDoc {
  const file = docPath(root, module.id);
  const { body } = parseDoc(fs.readFileSync(file, "utf8"));
  const code = codeFingerprint(module, files);
  fs.writeFileSync(file, render({ module: module.id, status: "approved", code, approved: today.toISOString().slice(0, 10) }, body));
  const snaps = readSnapshots(storeDir);
  snaps[module.id] = Object.fromEntries(module.files.map((p) => [p, files.get(p)?.h ?? ""]));
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(snapshotPath(storeDir), JSON.stringify(snaps));
  return readModuleDoc(root, module, files, storeDir);
}

/** Saves an agent's draft (never over an approved doc unless asked to replace it). */
export function saveDraft(root: string, moduleId: string, body: string, replaceApproved = false): { file: string; saved: boolean; reason?: string } {
  const file = docPath(root, moduleId);
  try {
    const { head } = parseDoc(fs.readFileSync(file, "utf8"));
    if (head.status === "approved" && !replaceApproved) return { file, saved: false, reason: "An approved doc is there; the draft would replace it. Ask the person first." };
  } catch {
    // No doc yet.
  }
  const lines = body.trim().split("\n");
  const trimmed = lines.length > MAX_DOC_LINES ? [...lines.slice(0, MAX_DOC_LINES), "", "(cut to stay short; keep only what code can't say)"] : lines;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render({ module: moduleId, status: "draft" }, trimmed.join("\n")));
  return { file, saved: true };
}

/**
 * What an agent gets: an approved doc only, with a note when the code moved on, and with any line
 * naming a file or code that no longer exists left out (and said so).
 */
export function serveModuleDoc(doc: ModuleDoc, exists: (name: string) => boolean): string | undefined {
  if (doc.status !== "approved") return undefined;
  const dropped: string[] = [];
  const kept = doc.body.split("\n").filter((line) => {
    const missing = [...line.matchAll(/`([^`\n]{2,100})`/g)].map((m) => m[1].trim()).filter((code) => (/^[\w./@-]+\.[a-z]{1,4}$/.test(code) || /^[A-Za-z_$][\w$]{2,}(\(\))?$/.test(code)) && !exists(code.replace(/\(\)$/, "")));
    if (missing.length) dropped.push(missing[0]);
    return !missing.length;
  });
  const notes: string[] = [];
  if (doc.approvedCode && doc.approvedCode !== doc.currentCode) {
    notes.push(`Note: approved ${doc.approvedOn ?? "earlier"}; the code changed since${doc.changedFiles !== undefined ? ` (${doc.changedFiles} file${doc.changedFiles === 1 ? "" : "s"})` : ""}. Check details against the code.`);
  }
  if (dropped.length) notes.push(`${dropped.length} line${dropped.length === 1 ? "" : "s"} left out: ${dropped.slice(0, 3).map((d) => `\`${d}\``).join(", ")} no longer exist${dropped.length === 1 ? "s" : ""}.`);
  return [`Module docs (${doc.module}), approved by the team:`, ...kept, ...notes].join("\n").trim();
}
