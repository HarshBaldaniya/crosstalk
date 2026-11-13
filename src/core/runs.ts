// Parallel runs: an agent working on a task by itself, in its own git worktree (outside the repo), with
// a token and time budget, the folders it may change (leases), and a log of everything it did. A run
// never commits or merges: when it ends, its changes wait for the person to apply or discard them.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { crosstalkFile, writeFileAtomic } from "./paths";

export type RunAgent = "claude" | "codex" | "gemini";
export type RunState = "running" | "needs-you" | "in-review" | "done" | "failed" | "stopped";

export interface RunBudget {
  /** Tokens the agent may use in all (input, output and cache writes) */
  tokens: number;
  minutes: number;
}

export interface Run {
  id: string;
  task: string;
  agent: RunAgent;
  /** The repo it works on, and its own copy of it */
  root: string;
  worktree: string;
  branch: string;
  /** What it was started from: a commit */
  base: string;
  state: RunState;
  budget: RunBudget;
  used: { tokens: number; ms: number; usd?: number };
  /** Folders it says it will change; overlapping runs are warned about before they start */
  leases: string[];
  createdAt: number;
  endedAt?: number;
  pid?: number;
  /** The agent's own last words */
  summary?: string;
  diff?: { files: number; added: number; removed: number; names: string[] };
  /** Why it stopped, when it didn't finish by itself */
  reason?: string;
  /** Runs started together on the same task, to compare */
  group?: string;
  /** What started it: "you", or an automation's name */
  trigger: string;
  /** How many runs deep: a run started because of a run. Automations refuse past 1 */
  hop: number;
}

export const runsDir = () => crosstalkFile("runs");
const runFile = (id: string) => path.join(runsDir(), `${id}.json`);
export const runLog = (id: string) => path.join(runsDir(), `${id}.log`);
export const worktreesDir = () => crosstalkFile("worktrees");

export function saveRun(r: Run): void {
  writeFileAtomic(runFile(r.id), JSON.stringify(r, null, 1));
}

export function readRun(id: string): Run | undefined {
  try {
    return JSON.parse(fs.readFileSync(runFile(id), "utf8")) as Run;
  } catch {
    return undefined;
  }
}

export function listRuns(root?: string): Run[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(runsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readRun(n.slice(0, -5)))
    .filter((r): r is Run => !!r && (!root || path.resolve(r.root) === path.resolve(root)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One line of the run's audit trail: what happened, when. Append-only. */
export function logRun(id: string, line: string): void {
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.appendFileSync(runLog(id), `${new Date().toISOString()} ${line.replace(/\n/g, " ")}\n`);
}

/** Running or waiting runs whose folders overlap these. */
export function leaseConflicts(leases: string[], root: string, runs = listRuns(root)): { run: Run; folders: string[] }[] {
  const norm = (f: string) => f.replace(/^\.\/?/, "").replace(/\/+$/, "");
  const mine = leases.map(norm).filter(Boolean);
  const out: { run: Run; folders: string[] }[] = [];
  for (const r of runs) {
    if (r.state !== "running" && r.state !== "needs-you" && r.state !== "in-review") continue;
    const theirs = r.leases.map(norm);
    // No leases means "anywhere": it overlaps everything.
    const hit = !mine.length || !theirs.length ? ["(the whole repo)"] : mine.filter((a) => theirs.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
    if (hit.length) out.push({ run: r, folders: hit });
  }
  return out;
}

// ---------------------------------------------------------------- the agents' own commands

/** The agent's headless command. None of them may skip permissions: edits only, inside the worktree. */
export function agentCommand(agent: RunAgent, task: string, opts: { worktree: string; lastMessageFile: string; maxUsd?: number }): { cmd: string; args: string[] } {
  if (agent === "claude") {
    const args = ["-p", task, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
    if (opts.maxUsd) args.push("--max-budget-usd", String(opts.maxUsd));
    return { cmd: "claude", args };
  }
  if (agent === "codex") return { cmd: "codex", args: ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", opts.worktree, "-o", opts.lastMessageFile, task] };
  return { cmd: "gemini", args: ["-p", task, "--approval-mode", "auto_edit", "-o", "stream-json"] };
}

/** Tokens and the final words from a line of the agent's JSON output, whatever its shape. */
export function readEvent(line: string): { tokens?: number; usd?: number; text?: string; final?: boolean; failed?: boolean } | undefined {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  const out: { tokens?: number; usd?: number; text?: string; final?: boolean; failed?: boolean } = {};
  const u = o?.message?.usage ?? o?.usage ?? o?.payload?.info?.last_token_usage ?? o?.stats?.models;
  if (u && typeof u === "object") {
    const n = (k: string) => (typeof u[k] === "number" ? u[k] : 0);
    const t = n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens") + n("prompt_tokens") + n("candidates_tokens");
    if (t) out.tokens = t;
  }
  if (o?.type === "result") {
    out.final = true;
    if (typeof o.result === "string") out.text = o.result;
    if (typeof o.response === "string") out.text = o.response;
    if (typeof o.total_cost_usd === "number") out.usd = o.total_cost_usd;
    if (o.is_error || o.subtype === "error") out.failed = true;
  }
  if (o?.type === "item.completed" && o.item?.type === "agent_message" && typeof o.item.text === "string") out.text = o.item.text;
  return out;
}

// ---------------------------------------------------------------- git

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;

export const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${err ? stderr : ""}` })));

async function diffOf(wt: string, base: string, exec: Exec): Promise<Run["diff"]> {
  // New files count too: marked as intended, so the diff sees them, without staging their content.
  await exec("git", ["add", "-N", "."], wt);
  const stat = await exec("git", ["diff", "--numstat", base], wt);
  let added = 0;
  let removed = 0;
  const names: string[] = [];
  for (const line of stat.out.split("\n")) {
    const m = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    added += Number(m[1]) || 0;
    removed += Number(m[2]) || 0;
    names.push(m[3]);
  }
  return { files: names.length, added, removed, names: names.slice(0, 50) };
}

// ---------------------------------------------------------------- starting and ending

export interface StartOptions {
  task: string;
  agent: RunAgent;
  root: string;
  budget?: Partial<RunBudget>;
  leases?: string[];
  trigger?: string;
  hop?: number;
  group?: string;
}

export interface RunDeps {
  exec?: Exec;
  /** Starts the agent; tests pass a fake */
  start?: (cmd: string, args: string[], cwd: string) => ChildProcess;
  /** Told whenever a run changes */
  onChange?: (r: Run) => void;
  /** The agent's command, with its path found on this computer */
  resolve?: (agent: RunAgent) => string | undefined;
}

export const DEFAULT_BUDGET: RunBudget = { tokens: 2_000_000, minutes: 30 };
const live = new Map<string, ChildProcess>();

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";

export async function startRun(o: StartOptions, deps: RunDeps = {}): Promise<Run> {
  const exec = deps.exec ?? realExec;
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
  const head = await exec("git", ["rev-parse", "HEAD"], o.root);
  if (!head.ok) throw new Error("A run needs a git repo with at least one commit.");
  const base = head.out.trim();
  const worktree = path.join(worktreesDir(), `${path.basename(o.root)}-${id}`);
  const branch = `crosstalk/${slug(o.task)}-${id.slice(-6)}`;
  fs.mkdirSync(worktreesDir(), { recursive: true });
  const add = await exec("git", ["worktree", "add", "-b", branch, worktree, base], o.root);
  if (!add.ok) throw new Error(`Couldn't make the run's own copy: ${add.out.slice(0, 300)}`);

  const run: Run = {
    id,
    task: o.task,
    agent: o.agent,
    root: o.root,
    worktree,
    branch,
    base,
    state: "running",
    budget: { ...DEFAULT_BUDGET, ...o.budget },
    used: { tokens: 0, ms: 0 },
    leases: o.leases ?? [],
    createdAt: Date.now(),
    trigger: o.trigger ?? "you",
    hop: o.hop ?? 0,
    group: o.group,
  };
  saveRun(run);
  logRun(id, `started by ${run.trigger} · ${o.agent} · budget ${run.budget.tokens} tokens, ${run.budget.minutes} min · leases ${run.leases.join(", ") || "none"} · task: ${o.task}`);

  const lastMessageFile = path.join(runsDir(), `${id}.last.txt`);
  const { cmd, args } = agentCommand(o.agent, o.task, { worktree, lastMessageFile });
  const resolved = deps.resolve?.(o.agent) ?? cmd;
  // stdin is closed: an agent left waiting for more input (Codex does) would sit until its time ran out.
  const child = (deps.start ?? ((c, a, cwd) => spawn(c, a, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(c), env: { ...process.env, CROSSTALK_RUN: id } })))(resolved, args, worktree);
  live.set(id, child);
  run.pid = child.pid;
  saveRun(run);
  deps.onChange?.(run);
  logRun(id, `command: ${path.basename(resolved)} ${args.map((a) => (a === o.task ? "<task>" : a)).join(" ")}`);

  const startedAt = Date.now();
  let lastText = "";
  let failed = false;
  let buf = "";
  const finish = async (state: RunState, reason?: string) => {
    if (!live.has(id)) return;
    live.delete(id);
    clearInterval(timer);
    const r = readRun(id) ?? run;
    r.used.ms = Date.now() - startedAt;
    r.endedAt = Date.now();
    r.pid = undefined;
    try {
      r.summary = (fs.existsSync(lastMessageFile) ? fs.readFileSync(lastMessageFile, "utf8") : lastText).trim().slice(0, 4000) || r.summary;
    } catch {
      r.summary = lastText.slice(0, 4000);
    }
    r.diff = await diffOf(worktree, base, exec);
    r.state = state === "done" && r.diff && r.diff.files > 0 ? "in-review" : state;
    if (reason) r.reason = reason;
    saveRun(r);
    logRun(id, `${r.state}${reason ? ` (${reason})` : ""} · ${r.used.tokens} tokens · ${Math.round(r.used.ms / 1000)} s · ${r.diff?.files ?? 0} files changed`);
    deps.onChange?.(r);
  };

  const onLine = (line: string) => {
    const ev = readEvent(line);
    if (!ev) return;
    const r = readRun(id) ?? run;
    if (ev.tokens) r.used.tokens += ev.tokens;
    if (ev.usd !== undefined) r.used.usd = ev.usd;
    if (ev.text) lastText = ev.text;
    if (ev.failed) failed = true;
    saveRun(r);
    if (r.used.tokens > r.budget.tokens) {
      logRun(id, `budget reached: ${r.used.tokens} of ${r.budget.tokens} tokens; stopping`);
      child.kill();
      void finish("stopped", `token budget reached (${r.used.tokens} of ${r.budget.tokens})`);
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr?.on("data", (d: Buffer) => logRun(id, `stderr: ${String(d).slice(0, 400)}`));
  const timer = setInterval(() => {
    if (Date.now() - startedAt > run.budget.minutes * 60_000) {
      logRun(id, `time budget reached: ${run.budget.minutes} min; stopping`);
      child.kill();
      void finish("stopped", `time budget reached (${run.budget.minutes} min)`);
    }
  }, 1000);
  timer.unref?.();
  child.on("error", (err) => void finish("failed", `the agent couldn't start: ${err.message}`));
  child.on("exit", (code) => void finish(code === 0 && !failed ? "done" : "failed", code === 0 && !failed ? undefined : `the agent ended with code ${code}`));
  return run;
}

export async function stopRun(id: string): Promise<void> {
  const child = live.get(id);
  logRun(id, "stopped by the person");
  if (child) child.kill();
  else {
    const r = readRun(id);
    if (r && r.state === "running") {
      r.state = "stopped";
      r.reason = "stopped by the person";
      r.endedAt = Date.now();
      saveRun(r);
    }
  }
}

/** Every run stops now: the kill switch. */
export async function stopAllRuns(): Promise<number> {
  const ids = [...live.keys()];
  for (const id of ids) await stopRun(id);
  return ids.length;
}

/** The run's changes, applied to the person's own checkout as uncommitted edits. Never a commit. */
export async function applyRun(id: string, exec: Exec = realExec): Promise<{ ok: boolean; message: string }> {
  const r = readRun(id);
  if (!r) return { ok: false, message: "No such run." };
  await exec("git", ["add", "-N", "."], r.worktree);
  const patch = await exec("git", ["diff", "--binary", r.base], r.worktree);
  if (!patch.out.trim()) return { ok: false, message: "This run changed nothing." };
  const file = path.join(runsDir(), `${id}.patch`);
  fs.writeFileSync(file, patch.out);
  const check = await exec("git", ["apply", "--check", "--3way", file], r.root);
  if (!check.ok) return { ok: false, message: `It doesn't apply cleanly to your checkout (your files changed since). The patch is at ${file}. ${check.out.slice(0, 300)}` };
  const done = await exec("git", ["apply", "--3way", file], r.root);
  if (!done.ok) return { ok: false, message: done.out.slice(0, 400) };
  r.state = "done";
  r.reason = "applied to your checkout";
  saveRun(r);
  logRun(id, `applied to ${r.root} as uncommitted changes`);
  return { ok: true, message: `Applied ${r.diff?.files ?? 0} files to your checkout as uncommitted changes. Review them in Source Control.` };
}

/** Removes the run's copy and branch; its log stays. */
export async function discardRun(id: string, exec: Exec = realExec): Promise<void> {
  const r = readRun(id);
  if (!r) return;
  if (live.has(id)) await stopRun(id);
  await exec("git", ["worktree", "remove", "--force", r.worktree], r.root);
  await exec("git", ["branch", "-D", r.branch], r.root);
  logRun(id, "discarded: its copy and branch removed");
  fs.rmSync(runFile(id), { force: true });
}

export const isLive = (id: string) => live.has(id);
