// The Library: Crosstalk's own commands and the person's, served to every agent as slash commands.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { allCommands, builtinCommands, parseCommand, renderCommand, STARTER_DESCRIPTION, suggest, userLibraryDir } from "../src/library/index";

beforeEach(() => {
  process.env.CROSSTALK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crosstalk-lib-home-"));
});

test("28 shipped commands in five packs, each short, complete and free of anything personal", () => {
  const cmds = builtinCommands();
  assert.equal(cmds.length, 28);
  assert.equal(new Set(cmds.map((c) => c.name)).size, 28, "names are unique");
  assert.deepEqual(packs2(cmds, "workflow"), ["plan", "build", "audit", "cleanup", "retro", "module-docs"]);
  assert.deepEqual(packs2(cmds, "sessions"), ["recall", "catchup", "handoff", "tokens"]);
  const packs = (p: string) => cmds.filter((c) => c.pack === p).map((c) => c.name);
  assert.deepEqual(packs("engineering"), ["spec", "review", "pr", "pr-review", "tests", "security", "design", "ci", "docs"]);
  assert.deepEqual(packs("product"), ["scope", "update", "research", "roadmap", "user-docs"]);
  assert.deepEqual(packs("connected"), ["email", "slack", "meeting", "notion"]);
  for (const c of cmds) {
    const placeholders = [...c.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    for (const p of placeholders) assert.ok(c.args.some((a) => a.name === p), `${c.name}: {{${p}}} has no argument`);
    for (const a of c.args) {
      assert.ok(placeholders.includes(a.name), `${c.name}: argument ${a.name} is never used`);
      if (!a.required) assert.match(a.description, /\(default: [^)]+\)/, `${c.name}: optional ${a.name} needs a default`);
    }
    assert.ok(c.triggers.length >= 4, `${c.name}: trigger phrases help suggest find it`);
    const tokens = Math.ceil(c.body.length / 4);
    assert.ok(tokens < 800, `${c.name} is ${tokens} tokens`);
    assert.doesNotMatch(`${c.description}\n${c.body}`, /\/Users\/|\/home\/|[A-Za-z]:\\Users\\|@[a-z0-9-]+\.[a-z]{2,}/i, `${c.name} names a person's files or email`);
    if (c.pack === "connected") assert.ok(c.needs, `${c.name} says which app it needs`);
  }
});

function packs2(cmds: ReturnType<typeof builtinCommands>, p: string) {
  return cmds.filter((c) => c.pack === p).map((c) => c.name);
}

test("arguments fill in; a missing one reads as its default, in the sentence", () => {
  const review = builtinCommands().find((c) => c.name === "review")!;
  assert.match(renderCommand(review, { changes: "PR #12", goal: "show upload progress" }), /^Review PR #12\. It should: show upload progress\./);
  assert.match(renderCommand(review), /^Review this branch against its base, plus uncommitted work\. It should: what the session log or PR body says\./);
  const scope = builtinCommands().find((c) => c.name === "scope")!;
  assert.match(renderCommand(scope, { idea: "referrals" }), /^Scope: referrals, for the people it serves; ask if unclear\./);
  assert.deepEqual(
    parseCommand("---\nname: x\nargs: a* = One; with a semicolon; b = Two (default: two; really)\n---\n{{a}} {{b}}")!.args.map((a) => [a.name, a.required, a.description]),
    [["a", true, "One; with a semicolon"], ["b", false, "Two (default: two; really)"]],
  );
  assert.equal(parseCommand("no header"), undefined);
  assert.equal(parseCommand("---\nname: Bad Name!\n---\nx"), undefined);
});

test("suggest picks the right command for plain asks, typos included: the right one in the top 3 for at least 80%", () => {
  const cases: [string, string][] = [
    ["review my changes before I open the PR", "review"],
    ["can you reveiw my code", "review"],
    ["check my diff for bugs", "review"],
    ["open a pull request for this", "pr"],
    ["ship this and raise a pr", "pr"],
    ["review PR #482", "pr-review"],
    ["answer the review comments on my pull request", "pr-review"],
    ["write tests for the billing service", "tests"],
    ["we need e2e tests for checkout", "tests"],
    ["is this endpoint secure", "security"],
    ["do a threat model of uploads", "security"],
    ["CI is failing on my branch", "ci"],
    ["the github actions build failed, fix it", "ci"],
    ["how should we structure the data model for invoices", "design"],
    ["design the API for webhooks", "design"],
    ["write a README for this package", "docs"],
    ["update the docs for the export command", "docs"],
    ["write a spec for team invites", "spec"],
    ["plan this feature: offline mode", "spec"],
    ["what's the smallest version of a referral program", "scope"],
    ["scope this feature for agencies", "scope"],
    ["weekly update for the team", "update"],
    ["write an investor update from this week", "update"],
    ["summarize this customer feedback", "research"],
    ["what are users saying in these interview notes", "research"],
    ["prioritize the backlog for next quarter", "roadmap"],
    ["write a help article on changing plans", "user-docs"],
    ["draft an email to the client about the delay", "email"],
    ["post an update in slack about the release", "slack"],
    ["what did we decide in yesterday's meeting", "meeting"],
    ["make a notion page for this project", "notion"],
    ["plan this change before we build it", "plan"],
    ["execute the plan in changes/invites", "build"],
    ["audit the change, is it really done", "audit"],
    ["find dead code and clean up", "cleanup"],
    ["what keeps going wrong, improve the rules", "retro"],
    ["which chat fixed the upload counter before", "recall"],
    ["what did the other chats do today", "catchup"],
    ["context is full, hand off to a new chat", "handoff"],
    ["why is this chat using so many tokens", "tokens"],
  ];
  let top1 = 0;
  let top3 = 0;
  const misses: string[] = [];
  for (const [ask, want] of cases) {
    const got = suggest(ask).map((s) => s.command.name);
    if (got[0] === want) top1++;
    if (got.includes(want)) top3++;
    else misses.push(`${ask} → ${got.join(", ") || "nothing"} (wanted ${want})`);
  }
  assert.ok(top3 / cases.length >= 0.8, `top 3: ${top3}/${cases.length}; misses:\n${misses.join("\n")}`);
  assert.ok(top1 / cases.length >= 0.7, `top 1: ${top1}/${cases.length}`);
  assert.deepEqual(suggest("asdf qwer"), []);
});

test("the person's own commands: private, from ~/.crosstalk/library, and one can replace a shipped command", () => {
  const dir = userLibraryDir();
  fs.mkdirSync(path.join(dir, "team"), { recursive: true });
  fs.writeFileSync(path.join(dir, "standup.md"), "---\nname: standup\ntitle: Standup\ndescription: Yesterday, today, blockers\ntriggers: standup, daily\n---\nWrite my standup.");
  fs.writeFileSync(path.join(dir, "team", "review.md"), "---\nname: review\ndescription: Our team's review\n---\nReview our way.");
  fs.writeFileSync(path.join(dir, "broken.md"), "no header here");
  const all = allCommands();
  assert.equal(all.length, 29);
  const standup = all.find((c) => c.name === "standup")!;
  assert.equal(standup.pack, "mine");
  assert.equal(standup.source, path.join(dir, "standup.md"));
  assert.equal(all.find((c) => c.name === "review")!.body, "Review our way.");
  assert.equal(suggest("write my daily standup")[0].command.name, "standup");
});

const built = path.join(__dirname, "..", "dist", "crosstalk-mcp.js");
test("every agent gets them as slash commands (MCP prompts), and a new file of the person's is offered without a restart", { skip: !fs.existsSync(built) && "run npm run build first" }, async () => {
  const child = spawn(process.execPath, [built], { env: { ...process.env, CROSSTALK_ROOT: os.tmpdir() }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map<number, (v: any) => void>();
  let listChanged = 0;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === "notifications/prompts/list_changed") listChanged++;
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const names = async () => ((await call("prompts/list", {})).result.prompts as { name: string }[]).map((p) => p.name);
    assert.equal((await names()).length, 28);
    const review = await call("prompts/get", { name: "review", arguments: { changes: "PR #9" } });
    assert.match(review.result.messages[0].content.text, /^Review PR #9\./);
    const email = ((await call("prompts/list", {})).result.prompts as { name: string; description: string }[]).find((p) => p.name === "email")!;
    assert.match(email.description, /needs gmail connected/);

    fs.mkdirSync(userLibraryDir(), { recursive: true });
    fs.writeFileSync(path.join(userLibraryDir(), "standup.md"), "---\nname: standup\ndescription: Daily standup\n---\nWrite my standup.");
    await new Promise((r) => setTimeout(r, 3500));
    assert.ok((await names()).includes("standup"), "offered without a restart");
    assert.ok(listChanged >= 1, "and the agent is told the list changed");
  } finally {
    child.kill();
  }
});

test("a new command left as it was started is not listed anywhere", () => {
  fs.mkdirSync(userLibraryDir(), { recursive: true });
  fs.writeFileSync(path.join(userLibraryDir(), "my-command.md"), `---\nname: my-command\ntitle: My command\ndescription: ${STARTER_DESCRIPTION}\n---\nWork on it.`);
  assert.ok(!allCommands().some((c) => c.name === "my-command"));
  fs.writeFileSync(path.join(userLibraryDir(), "my-command.md"), "---\nname: my-command\ntitle: Weekly notes\ndescription: Turn the week's commits into notes\n---\nWrite them.");
  assert.ok(allCommands().some((c) => c.name === "my-command"));
});
