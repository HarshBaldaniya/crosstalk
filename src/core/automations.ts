// Automations: runs that start without you typing, and always end with something for you to approve.
// Every one is a parallel run (its own worktree, budget and log), and none starts unless every rail
// agrees: switched on, not paused, under its daily cap, not a repeat, not triggered by a run.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkFile, readJson, writeFileAtomic } from "./paths";
import type { RunAgent, RunBudget } from "./runs";
import { worktreesDir } from "./runs";

export type Trigger =
  | { kind: "chat-finished"; match?: string }
  | { kind: "schedule"; at: string; days?: number[] }
  | { kind: "file-saved"; glob: string }
  | { kind: "ci-failed" };

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  root: string;
  on: Trigger;
  agent: RunAgent;
  /** The task; {{chat}}, {{did}}, {{file}}, {{log}} are filled from what happened */
  task: string;
  budget: RunBudget;
  leases: string[];
  /** Most runs a day */
  dailyCap: number;
}

export interface TriggerEvent {
  kind: Trigger["kind"];
  /** Where it happened: a chat's folder, a saved file */
  cwd?: string;
  file?: string;
  chat?: string;
  did?: string;
  log?: string;
  /** For schedules: the minute it's for */
  at?: number;
}

const file = () => crosstalkFile("automations.json");
const auditFile = () => crosstalkFile("automations.jsonl");

export function listAutomations(): Automation[] {
  return readJson<Automation[]>(file(), []);
}

export function saveAutomations(list: Automation[]): void {
  writeFileAtomic(file(), JSON.stringify(list, null, 1));
}

export function isPaused(): boolean {
  return readJson<{ automationsPaused?: boolean }>(crosstalkFile("config.json"), {}).automationsPaused === true;
}

export function setPaused(paused: boolean): void {
  const cfg = readJson<Record<string, unknown>>(crosstalkFile("config.json"), {});
  cfg.automationsPaused = paused;
  writeFileAtomic(crosstalkFile("config.json"), JSON.stringify(cfg, null, 1));
}

interface AuditLine {
  at: number;
  automation: string;
  event: string;
  decision: "started" | "skipped";
  why?: string;
  run?: string;
  key?: string;
}

export function audit(line: AuditLine): void {
  fs.mkdirSync(path.dirname(auditFile()), { recursive: true });
  fs.appendFileSync(auditFile(), `${JSON.stringify(line)}\n`);
}

export function readAudit(max = 200): AuditLine[] {
  try {
    return fs
      .readFileSync(auditFile(), "utf8")
      .trim()
      .split("\n")
      .slice(-max)
      .map((l) => JSON.parse(l) as AuditLine);
  } catch {
    return [];
  }
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      inBrace = true;
    } else if (c === "}" && inBrace) {
      re += ")";
      inBrace = false;
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a trigger matches what happened (the rails are checked after). */
export function matches(a: Automation, e: TriggerEvent): boolean {
  if (a.on.kind !== e.kind) return false;
  if (a.on.kind === "chat-finished") {
    if (e.cwd && path.resolve(e.cwd) !== path.resolve(a.root)) return false;
    const m = a.on.match?.trim().toLowerCase();
    return !m || (e.chat ?? "").toLowerCase().includes(m);
  }
  if (a.on.kind === "file-saved") {
    if (!e.file) return false;
    const rel = path.relative(a.root, e.file).split(path.sep).join("/");
    return !rel.startsWith("..") && globToRegExp(a.on.glob).test(rel);
  }
  if (a.on.kind === "schedule") {
    const d = new Date(e.at ?? Date.now());
    const [h, m] = a.on.at.split(":").map(Number);
    return d.getHours() === h && d.getMinutes() === m && (!a.on.days?.length || a.on.days.includes(d.getDay()));
  }
  return true;
}

/** The task with what happened filled in. */
export function fillTask(a: Automation, e: TriggerEvent): string {
  const v: Record<string, string> = { chat: e.chat ?? "", did: e.did ?? "", file: e.file ? path.relative(a.root, e.file) : "", log: (e.log ?? "").slice(-6000) };
  return a.task.replace(/\{\{\s*(chat|did|file|log)\s*\}\}/g, (_m, k: string) => v[k] || "(not given)");
}

export interface Decision {
  start: boolean;
  why: string;
  task?: string;
  key?: string;
}

/**
 * Every rail, in order. A run starts only when all of them agree:
 * on, not paused, the event isn't a run's own doing (loop guard), it matches, under the daily cap, not a repeat
 * of the same thing within the hour.
 */
export function decide(a: Automation, e: TriggerEvent, now = Date.now(), history = readAudit(500)): Decision {
  if (!a.enabled) return { start: false, why: "switched off" };
  if (isPaused()) return { start: false, why: "all automations are paused" };
  const runsHome = path.resolve(worktreesDir());
  if ((e.cwd && path.resolve(e.cwd).startsWith(runsHome)) || (e.file && path.resolve(e.file).startsWith(runsHome)) || process.env.CROSSTALK_RUN) {
    return { start: false, why: "loop guard: started by a run, and runs never start runs" };
  }
  if (!matches(a, e)) return { start: false, why: "doesn't match" };
  const today = new Date(now).toDateString();
  const todays = history.filter((h) => h.automation === a.id && h.decision === "started" && new Date(h.at).toDateString() === today).length;
  if (todays >= a.dailyCap) return { start: false, why: `daily cap reached (${a.dailyCap})` };
  const task = fillTask(a, e);
  const key = crypto.createHash("sha1").update(`${a.id}\0${task}`).digest("hex").slice(0, 16);
  if (history.some((h) => h.key === key && h.decision === "started" && now - h.at < 60 * 60_000)) return { start: false, why: "the same thing ran within the hour", key };
  return { start: true, why: "every rail agrees", task, key };
}

/** Ready-made automations to start from. */
export const TEMPLATES: Omit<Automation, "id" | "root" | "enabled">[] = [
  {
    name: "Review every finished chat's changes",
    on: { kind: "chat-finished" },
    agent: "codex",
    task: "Another AI chat just finished work in this repo: \"{{chat}}\". What it says it did: {{did}}\n\nReview its uncommitted changes the way /crosstalk:review does: real bugs, security, missing tests, with path:line and a concrete failure for each. Change nothing; write the review as your answer.",
    budget: { tokens: 600_000, minutes: 15 },
    leases: [],
    dailyCap: 6,
  },
  {
    name: "When CI fails, find the cause and propose a fix",
    on: { kind: "ci-failed" },
    agent: "claude",
    task: "CI failed on this branch. The failing log:\n\n{{log}}\n\nFind the first real error, reproduce it, and fix the cause (not the symptom). Run the same command to prove it passes. Change only what the fix needs.",
    budget: { tokens: 1_500_000, minutes: 30 },
    leases: [],
    dailyCap: 3,
  },
  {
    name: "Every morning: find unused code and stale docs",
    on: { kind: "schedule", at: "09:00", days: [1, 2, 3, 4, 5] },
    agent: "claude",
    task: "Run the clean-up check: crosstalk_map with check \"unused\" and check \"docs\". Verify each candidate with a search. Change nothing; answer with what's safe to remove and which doc lines to fix.",
    budget: { tokens: 400_000, minutes: 10 },
    leases: [],
    dailyCap: 1,
  },
  {
    name: "When the API schema changes, update the client types",
    on: { kind: "file-saved", glob: "**/openapi*.{json,yaml,yml}" },
    agent: "claude",
    task: "The API schema changed ({{file}}). Update the client types and calls that depend on it so the project type-checks again. Run the type check to prove it.",
    budget: { tokens: 1_000_000, minutes: 20 },
    leases: [],
    dailyCap: 4,
  },
];
