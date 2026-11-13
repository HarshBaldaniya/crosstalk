// Module docs: drafted by an agent, approved by a person, served to agents only when approved, and
// honest when the code moves on.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeMap } from "../src/codemap/index";
import { docPath, docSlug, saveDraft } from "../src/codemap/moduledocs";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-md-home-");
});

function project(): string {
  const root = tmp("crosstalk-md-repo-");
  const files: Record<string, string> = {
    "features/upload/queue.ts": "export function enqueue() {}\nexport function drain() {}\n",
    "features/upload/tray.tsx": 'import { enqueue } from "./queue";\nexport function Tray() { enqueue(); return null; }\n',
    "features/upload/limits.ts": "export const MAX_FILES = 5;\n",
    "features/upload/retry.ts": "export function retry() {}\n",
  };
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  }
  return root;
}

const DRAFT = [
  "**What it's for:** uploads run through one queue.",
  "**How it works:** `enqueue` adds a file; `drain` sends them one at a time.",
  "**Rules:** never call `drain` from a component; `Tray` only enqueues.",
  "**Watch out:** `features/upload/limits.ts` caps a batch.",
].join("\n");

test("a draft is never given to agents; approving stamps it with the code it describes", async () => {
  const root = project();
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  assert.equal(map.modules()[0].id, "features/upload");
  assert.equal(map.moduleDoc("features/upload")!.status, "missing");
  assert.equal(docSlug("features/upload"), "features-upload");

  assert.ok(saveDraft(root, "features/upload", DRAFT).saved);
  assert.equal(map.moduleDoc("features/upload")!.status, "draft");
  assert.doesNotMatch(map.outline("features/upload"), /Module docs/, "drafts stay out of agents' answers");

  const approved = map.approveModuleDoc("features/upload")!;
  assert.equal(approved.status, "approved");
  assert.match(fs.readFileSync(docPath(root, "features/upload"), "utf8"), /^---\nmodule: features\/upload\nstatus: approved\ncode: [0-9a-f]{16}\napproved: \d{4}-\d{2}-\d{2}\n---\n/);
  const out = map.outline("features/upload");
  assert.match(out, /Module docs \(features\/upload\), approved by the team:\n\*\*What it's for:\*\* uploads run through one queue\./);
  assert.doesNotMatch(out, /code changed since/);
  assert.ok(!saveDraft(root, "features/upload", "new draft").saved, "a draft never overwrites an approved doc unless asked");
});

test("when the code moves on: the doc says how much changed, and lines naming code that's gone are left out", async () => {
  const root = project();
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  saveDraft(root, "features/upload", DRAFT);
  map.approveModuleDoc("features/upload");

  // drain is renamed; limits.ts is deleted.
  fs.writeFileSync(path.join(root, "features/upload/queue.ts"), "export function enqueue() {}\nexport function flush() {}\n");
  fs.rmSync(path.join(root, "features/upload/limits.ts"));
  await map.refresh({ changed: ["features/upload/queue.ts", "features/upload/limits.ts"] });

  const doc = map.moduleDoc("features/upload")!;
  assert.equal(doc.changedFiles, 2);
  const out = map.outline("features/upload");
  assert.match(out, /Note: approved .*; the code changed since \(2 files\)\. Check details against the code\./);
  assert.match(out, /3 lines left out: `drain`, `drain`, `features\/upload\/limits\.ts` no longer exist\./);
  assert.match(out, /\*\*What it's for:\*\*/, "lines that are still true stay");
  assert.doesNotMatch(out, /never call `drain`/);

  map.approveModuleDoc("features/upload");
  assert.doesNotMatch(map.outline("features/upload"), /code changed since/, "approving again accepts today's code");
});
