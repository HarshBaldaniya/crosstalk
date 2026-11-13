// Parallel runs and automations: a real git repo, a stand-in agent, and every rail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { applyRun, discardRun, leaseConflicts, listRuns, readEvent, readRun, runLog, startRun, worktreesDir, type Run } from "../src/core/runs";
import { audit, decide, fillTask, matches, setPaused, TEMPLATES, type Automation } from "../src/core/automations";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-runs-home-");
});

function repo(): string {
  const root = tmp("crosstalk-runs-repo-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  // Windows' git turns \n into \r\n on checkout by default; the test compares exact text.
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "app.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return root;
}

/** A stand-in agent: streams JSON events like the real ones, edits a file, adds one, and ends. */
function fakeAgent(opts: { tokensPerEvent?: number; events?: number; sleepMs?: number; exitCode?: number } = {}) {
  const script = path.join(tmp("crosstalk-fake-"), "agent.js");
  fs.writeFileSync(
    script,
    `const fs = require("fs");
const n = ${opts.events ?? 3}, per = ${opts.tokensPerEvent ?? 1000};
let i = 0;
const tick = () => {
  if (i++ < n) { console.log(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: per, output_tokens: 0 } } })); return setTimeout(tick, ${opts.sleepMs ?? 10}); }
  fs.writeFileSync("app.ts", "export const a = 2;\\n");
  fs.writeFileSync("new.ts", "export const b = 1;\\n");
  console.log(JSON.stringify({ type: "result", result: "Changed a to 2 and added b.", total_cost_usd: 0.01 }));
  process.exit(${opts.exitCode ?? 0});
};
tick();`,
  );
  return (_cmd: string, _args: string[], cwd: string) => spawn(process.execPath, [script], { cwd });
}

const ended = (id: string) =>
  new Promise<Run>((resolve) => {
    const t = setInterval(() => {
      const r = readRun(id);
      if (r && r.state !== "running") {
        clearInterval(t);
        resolve(r);
      }
    }, 20);
  });

test("a run works in its own copy outside the repo, and waits for review with its diff and summary", async () => {
  const root = repo();
  const run = await startRun({ task: "Change a to 2", agent: "claude", root, leases: ["src"] }, { start: fakeAgent() });
  assert.ok(run.worktree.startsWith(worktreesDir()), "never inside the repo");
  assert.match(run.branch, /^crosstalk\/change-a-to-2-/);
  const r = await ended(run.id);
  assert.equal(r.state, "in-review");
  assert.deepEqual([r.diff?.files, r.diff?.added, r.diff?.removed], [2, 2, 1]);
  assert.deepEqual(r.diff?.names.sort(), ["app.ts", "new.ts"]);
  assert.equal(r.summary, "Changed a to 2 and added b.");
  assert.equal(r.used.tokens, 3000);
  assert.equal(r.used.usd, 0.01);
  assert.equal(fs.readFileSync(path.join(root, "app.ts"), "utf8"), "export const a = 1;\n", "the person's checkout is untouched until they apply");
  const log = fs.readFileSync(runLog(run.id), "utf8");
  assert.match(log, /started by you · claude · budget 2000000 tokens, 30 min · leases src · task: Change a to 2/);
  assert.match(log, /in-review · 3000 tokens · \d+ s · 2 files changed/);
});

test("applying gives uncommitted changes, never a commit; discarding removes the copy and its branch", async () => {
  const root = repo();
  const run = await startRun({ task: "Change a", agent: "codex", root }, { start: fakeAgent() });
  await ended(run.id);
  const commits = () => execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const applied = await applyRun(run.id);
  assert.ok(applied.ok, applied.message);
  assert.equal(fs.readFileSync(path.join(root, "app.ts"), "utf8"), "export const a = 2;\n");
  assert.ok(fs.existsSync(path.join(root, "new.ts")));
  assert.equal(commits(), "1", "no commit was made");
  await discardRun(run.id);
  assert.ok(!fs.existsSync(run.worktree));
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: root, encoding: "utf8" }), /crosstalk\//);
  assert.equal(readRun(run.id), undefined);
  assert.ok(fs.existsSync(runLog(run.id)), "the log stays");
});

test("a run stops at its token budget, and at its time budget", async () => {
  const root = repo();
  const big = await startRun({ task: "Spend", agent: "claude", root, budget: { tokens: 2500 } }, { start: fakeAgent({ events: 50, tokensPerEvent: 1000, sleepMs: 20 }) });
  const r = await ended(big.id);
  assert.equal(r.state, "stopped");
  assert.match(r.reason ?? "", /token budget reached \(3000 of 2500\)/);
  const slow = await startRun({ task: "Slow", agent: "claude", root, budget: { minutes: 0.02 } }, { start: fakeAgent({ events: 1000, tokensPerEvent: 1, sleepMs: 50 }) });
  const s = await ended(slow.id);
  assert.equal(s.state, "stopped");
  assert.match(s.reason ?? "", /time budget reached/);
});

test("a run whose agent fails is marked failed; overlapping folders are flagged before starting", async () => {
  const root = repo();
  const bad = await startRun({ task: "Fail", agent: "gemini", root }, { start: fakeAgent({ exitCode: 3 }) });
  const r = await ended(bad.id);
  assert.equal(r.state, "failed");
  assert.match(r.reason ?? "", /code 3/);
  const a = await startRun({ task: "Long", agent: "claude", root, leases: ["features/upload"] }, { start: fakeAgent({ events: 100, sleepMs: 30 }) });
  assert.deepEqual(leaseConflicts(["features/upload/tray"], root).map((c) => c.folders), [["features/upload/tray"]]);
  assert.deepEqual(leaseConflicts(["features/billing"], root), []);
  assert.equal(leaseConflicts([], root).length, 1, "no leases means the whole repo");
  assert.equal(listRuns(root).length, 2);
  await discardRun(a.id);
});

test("reading the agents' output: Claude, Codex and Gemini events", () => {
  assert.deepEqual(readEvent('{"type":"assistant","message":{"usage":{"input_tokens":5,"output_tokens":7,"cache_creation_input_tokens":3}}}'), { tokens: 15 });
  assert.deepEqual(readEvent('{"type":"result","result":"Done.","total_cost_usd":0.2,"is_error":false}'), { final: true, text: "Done.", usd: 0.2 });
  assert.deepEqual(readEvent('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'), { tokens: 120 });
  assert.deepEqual(readEvent('{"type":"item.completed","item":{"type":"agent_message","text":"Fixed it."}}'), { text: "Fixed it." });
  assert.equal(readEvent("not json"), undefined);
});

const auto = (over: Partial<Automation> = {}): Automation => ({ id: "a1", name: "Review", enabled: true, root: "/repo", on: { kind: "chat-finished" }, agent: "codex", task: "Review {{chat}}: {{did}}", budget: { tokens: 1000, minutes: 5 }, leases: [], dailyCap: 2, ...over });

test("automations: every rail must agree before a run starts", () => {
  const e = { kind: "chat-finished" as const, cwd: "/repo", chat: "Upload fix", did: "Fixed the counter." };
  const ok = decide(auto(), e, Date.now(), []);
  assert.deepEqual([ok.start, ok.task], [true, "Review Upload fix: Fixed the counter."]);
  assert.equal(decide(auto({ enabled: false }), e, Date.now(), []).why, "switched off");
  setPaused(true);
  assert.equal(decide(auto(), e, Date.now(), []).why, "all automations are paused");
  setPaused(false);
  assert.equal(decide(auto(), { ...e, cwd: "/other" }, Date.now(), []).why, "doesn't match");
  assert.match(decide(auto(), { ...e, cwd: path.join(worktreesDir(), "repo-x") }, Date.now(), []).why, /^loop guard/);
  const now = Date.now();
  const started = (key?: string) => ({ at: now - 1000, automation: "a1", event: "chat-finished", decision: "started" as const, key });
  assert.equal(decide(auto(), e, now, [started(), started()]).why, "daily cap reached (2)");
  assert.equal(decide(auto(), e, now, [started(ok.key)]).why, "the same thing ran within the hour");
  assert.equal(decide(auto(), e, now + 2 * 3600_000, [started(ok.key)]).start, true, "an hour later it may run again");
  audit({ at: now, automation: "a1", event: "chat-finished", decision: "started", key: ok.key });
});

test("automations: schedules, saved files and the shipped templates", () => {
  const at = new Date(2026, 10, 16, 9, 0).getTime(); // a Monday, 09:00
  const sched = auto({ on: { kind: "schedule", at: "09:00", days: [1, 2, 3, 4, 5] } });
  assert.ok(matches(sched, { kind: "schedule", at }));
  assert.ok(!matches(sched, { kind: "schedule", at: at + 60_000 }));
  assert.ok(!matches(sched, { kind: "schedule", at: new Date(2026, 10, 15, 9, 0).getTime() }), "not on a Sunday");
  const saved = auto({ on: { kind: "file-saved", glob: "**/openapi*.{json,yaml,yml}" } });
  assert.ok(matches(saved, { kind: "file-saved", file: "/repo/api/openapi.yaml" }));
  assert.ok(!matches(saved, { kind: "file-saved", file: "/repo/api/schema.ts" }));
  assert.ok(!matches(saved, { kind: "file-saved", file: "/elsewhere/openapi.json" }));
  assert.equal(fillTask(auto({ task: "Fix {{log}} in {{file}}" }), { kind: "ci-failed", log: "x".repeat(7000) }).length, "Fix  in (not given)".length + 6000);
  assert.equal(TEMPLATES.length, 4);
  for (const t of TEMPLATES) assert.ok(t.dailyCap >= 1 && t.budget.minutes <= 30 && t.budget.tokens <= 2_000_000, `${t.name} has bounded rails`);
});
