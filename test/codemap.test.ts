// The code map: what a parser finds in a file, how imports resolve, who uses what, how it ranks,
// and how it stays fresh. Each test builds a small project in a temporary folder.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { extract } from "../src/codemap/extract";
import { CodeMap, tokensOf } from "../src/codemap/index";
import { makeResolver, readJsonc } from "../src/codemap/resolve";
import { editDistance, words } from "../src/codemap/search";
import { folderId, storeDir } from "../src/codemap/store";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
beforeEach(() => {
  process.env.CROSSTALK_HOME = tmp("crosstalk-map-home-");
});

function project(files: Record<string, string>): string {
  const root = tmp("crosstalk-map-repo-");
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

const APP: Record<string, string> = {
  "tsconfig.json": `{
    // comments and trailing commas, like real ones
    "compilerOptions": {
      "paths": { "@/*": ["./*"], "react": ["./node_modules/@types/react"], },
    },
  }`,
  "features/account/hooks/useEditRights.ts": `import { roleOf } from "@/shared/roles";
import type { Member } from "../types";

/** Edit-rights primitive: resolves the caller's own role. */
export function useEditRights(member: Member): boolean {
  return roleOf(member) !== "viewer";
}
`,
  "features/account/types.ts": `export interface Member {
  id: string;
  role: string;
}
export type Role = "owner" | "viewer";
export enum Plan { Free, Pro }
`,
  "features/account/index.ts": `export { useEditRights } from "./hooks/useEditRights";
export * from "./types";
`,
  "shared/roles.ts": `// Every role a member can have.
export const ROLES = ["owner", "viewer"];
export const roleOf = (m: { role: string }) => m.role;
const helper = () => 1;
`,
  "features/upload/TransferTray.tsx": `import { useEditRights } from "@/features/account";
import UploadCounter from "./UploadCounter";
import * as api from "./api.js";

// The tray in the corner that lists uploads in progress.
export default function TransferTray() {
  const can = useEditRights({ id: "1", role: "owner" });
  api.cancelUpload("x");
  return <div>{can ? <UploadCounter count={2} /> : null}</div>;
}
`,
  "features/upload/UploadCounter.tsx": `type Props = { count: number };
const UploadCounter = ({ count }: Props) => <span>{count}</span>;
export default UploadCounter;
`,
  "features/upload/api.ts": `export async function cancelUpload(id: string) {
  return fetch("/api/uploads/" + id, { method: "DELETE" });
}
export class UploadClient {
  start() {}
  stop = () => {};
}
`,
  "tests/upload.test.ts": `import { cancelUpload } from "../features/upload/api";
function rights() { return cancelUpload("t"); }
`,
  "backend/app/__init__.py": "",
  "backend/app/billing.py": `"""Charges and refunds."""
from .models import Invoice

TAX_RATE = 0.18

def charge(invoice: Invoice) -> int:
    """Charge an invoice, tax included."""
    return round(invoice.total * (1 + TAX_RATE))
`,
  "backend/app/models.py": `class Invoice:
    """One bill."""
    total: int = 0

    def pay(self):
        return True
`,
  "backend/app/routes.py": `from fastapi import APIRouter
from . import billing
from .models import Invoice

router = APIRouter()

@router.post("/invoices/{id}/charge")
def charge_invoice(id: str):
    return billing.charge(Invoice())
`,
  "node_modules/react/index.js": "export const nope = 1;",
};

test("a TypeScript file: functions, hooks, components, interfaces, types, enums, classes and methods, with real ranges and docs", async () => {
  const facts = await extract("tsx", APP["features/upload/TransferTray.tsx"]);
  const tray = facts.decls.find((d) => d.n === "TransferTray")!;
  assert.equal(tray.k, "component");
  assert.deepEqual([tray.s, tray.e], [6, 10]);
  assert.equal(tray.x, true);
  assert.equal(tray.d, "The tray in the corner that lists uploads in progress.");
  assert.equal(facts.def, "TransferTray");

  const types = await extract("typescript", APP["features/account/types.ts"]);
  assert.deepEqual(types.decls.map((d) => [d.n, d.k, d.s, d.e]), [["Member", "interface", 1, 4], ["Role", "type", 5, 5], ["Plan", "enum", 6, 6]]);

  const api = await extract("typescript", APP["features/upload/api.ts"]);
  assert.deepEqual(api.decls.map((d) => `${d.p ? `${d.p}.` : ""}${d.n}:${d.k}`), ["cancelUpload:function", "UploadClient:class", "UploadClient.start:method", "UploadClient.stop:method"]);

  const hook = await extract("typescript", APP["features/account/hooks/useEditRights.ts"]);
  assert.equal(hook.decls[0].k, "hook");
  assert.equal(hook.decls[0].d, "Edit-rights primitive: resolves the caller's own role.");

  const roles = await extract("typescript", APP["shared/roles.ts"]);
  assert.deepEqual(roles.decls.map((d) => d.n), ["ROLES", "roleOf", "helper"], "functions are kept, exported or not");
  const consts = await extract("typescript", "const local = 1;\nconst LIMIT = 2;\nexport const shared = 3;\n");
  assert.deepEqual(consts.decls.map((d) => d.n), ["LIMIT", "shared"], "an unexported lower-case constant is noise");
});

test("a Python file: classes, methods, functions, constants, docstrings and web routes", async () => {
  const routes = await extract("python", APP["backend/app/routes.py"], () => true);
  const r = routes.decls.find((d) => d.n === "charge_invoice")!;
  assert.equal(r.k, "route");
  assert.equal(r.route, "POST /invoices/{id}/charge");
  assert.deepEqual(r.r?.sort(), ["Invoice", "billing.charge"]);
  const models = await extract("python", APP["backend/app/models.py"]);
  assert.deepEqual(models.decls.map((d) => [d.n, d.k, d.p ?? "", d.d ?? ""]), [["Invoice", "class", "", "One bill."], ["pay", "method", "Invoice", ""]]);
  const billing = await extract("python", APP["backend/app/billing.py"]);
  assert.deepEqual(billing.decls.map((d) => d.n), ["TAX_RATE", "charge"]);
});

test("imports resolve through tsconfig aliases (JSON with comments), index files, .js written for .ts, and Python packages", () => {
  const root = project(APP);
  assert.deepEqual(readJsonc('{ "a": "// not a comment", /* x */ "b": [1,], }'), { a: "// not a comment", b: [1] });
  const files = new Set(Object.keys(APP).filter((f) => !f.startsWith("node_modules")));
  const r = makeResolver(root, files);
  assert.equal(r.resolve("features/upload/TransferTray.tsx", "@/features/account"), "features/account/index.ts");
  assert.equal(r.resolve("features/upload/TransferTray.tsx", "./api.js"), "features/upload/api.ts");
  assert.equal(r.resolve("features/account/hooks/useEditRights.ts", "../types"), "features/account/types.ts");
  assert.equal(r.resolve("backend/app/routes.py", ".models"), "backend/app/models.py");
  assert.equal(r.resolve("backend/app/routes.py", ".billing"), "backend/app/billing.py");
  assert.equal(r.isLocal("react"), false, "an alias into node_modules is not this codebase");
  assert.equal(r.isLocal("@/shared/roles"), true);
});

test("who uses what: through re-exports, default exports, namespace imports and Python modules, each link marked by how sure it is", async () => {
  const root = project(APP);
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  const g = map.graph;
  const users = (file: string, name: string) => g.usedBy(file, name).map((e) => `${e.from.name}${e.conf === "found" ? "" : ` (${e.conf})`}`).sort();
  assert.deepEqual(users("features/account/hooks/useEditRights.ts", "useEditRights"), ["TransferTray (likely)"], "through the features/account barrel");
  assert.deepEqual(users("features/upload/UploadCounter.tsx", "UploadCounter"), ["TransferTray"], "a default import renders it");
  assert.deepEqual(users("features/upload/api.ts", "cancelUpload"), ["TransferTray", "rights"]);
  assert.deepEqual(users("shared/roles.ts", "roleOf"), ["useEditRights"]);
  assert.deepEqual(users("backend/app/billing.py", "charge"), ["charge_invoice"], "billing.charge() through `from . import billing`");
  assert.deepEqual(users("backend/app/models.py", "Invoice"), ["charge", "charge_invoice"]);
  assert.ok(!map.file("node_modules/react/index.js"), "node_modules is never mapped");
});

test("finding: an exact name wins, kind words pick a kind, typos and short forms still match, tests rank low", async () => {
  const root = project(APP);
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  const first = (q: string) => map.find(q).split("\n")[0];
  assert.match(first("useEditRights"), /^useEditRights {2}hook {2}features\/account\/hooks\/useEditRights\.ts:5-7 {2}· used by 1/);
  assert.match(first("where is the edit rights hook"), /^useEditRights /, "not the test helper named `rights`");
  assert.match(first("transfer tray component"), /^TransferTray {2}component/);
  assert.match(first("tranfser tray"), /^TransferTray /, "a typo");
  assert.match(first("upload count"), /UploadCounter/, "a short form");
  assert.match(first("charge invoice route"), /^charge_invoice {2}POST \/invoices\/\{id\}\/charge/);
  assert.ok(tokensOf(map.find("upload")) <= 300, "every answer fits its budget");
  assert.match(map.find("zzqqxx"), /Nothing in the code map matches/);
  assert.deepEqual(words("useEditRights billing_charge UploadCounter2s"), ["use", "edit", "right", "billing", "charge", "upload", "counter"]);
  assert.equal(editDistance("tranfser", "transfer", 2), 1);
});

test("a chat's own files rank up: the same words find different code for different work", async () => {
  const root = project({
    "billing/Counter.tsx": "export function Counter() { return null; }\n",
    "upload/Counter.tsx": "export function Counter() { return null; }\nexport function UploadPanel() { return null; }\n",
    "upload/Panel.tsx": 'import { UploadPanel } from "./Counter";\nexport function Panel() { return UploadPanel(); }\n',
  });
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  const top = (focus: string[]) => map.findHits("counter", { focus })[0].doc.file.p;
  assert.equal(top(["upload/Panel.tsx"]), "upload/Counter.tsx");
  assert.equal(top(["billing/Counter.tsx"]), "billing/Counter.tsx");
});

test("outline, graph and overview answer in a few hundred tokens, with lines read from the file itself", async () => {
  const root = project({ ...APP, "package.json": JSON.stringify({ scripts: { dev: "next dev", test: "vitest", postinstall: "x" } }) });
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  const file = map.outline("features/upload/api.ts");
  assert.match(file, /^features\/upload\/api\.ts {2}7 lines/);
  assert.match(file, / {2}5-5 {4}start\(\) \{\}/, "methods sit under their class");
  assert.match(file, / {2}1-3 {2}export async function cancelUpload\(id: string\)/);
  assert.match(file, /imported by 2: features\/upload\/TransferTray\.tsx, tests\/upload\.test\.ts|imported by 2: tests\/upload\.test\.ts, features\/upload\/TransferTray\.tsx/);
  const folder = map.outline("features");
  assert.match(folder, /^features\/ {2}6 files/);
  assert.match(folder, / {2}account\/ {2}3 files/);
  const sym = map.outline("UploadClient");
  assert.match(sym, /features\/upload\/api\.ts:4-7 {2}class/);
  assert.match(sym, /members: start 5, stop 6/);
  const graph = map.graphOf("cancelUpload");
  assert.match(graph, /used by 2:\n {2}TransferTray {2}features\/upload\/TransferTray\.tsx\n {2}rights {2}tests\/upload\.test\.ts/);
  const overview = map.overview();
  assert.match(overview, /commands: npm run dev · npm run test/);
  assert.match(overview, /1 web routes/);
  for (const t of [file, folder, sym, graph, overview]) assert.ok(tokensOf(t) <= 600, t);
});

test("fresh in a sweep: only changed files are read again; deletions and new files follow; nothing is written into the repo", async () => {
  const root = project(APP);
  const map = new CodeMap(root);
  const first = await map.refresh({ full: true });
  assert.equal(first.parsed, first.files);
  assert.equal((await new CodeMap(root).refresh()).parsed, 0, "a new process loads the saved map and reads nothing");

  fs.writeFileSync(path.join(root, "shared/roles.ts"), APP["shared/roles.ts"] + "export function isOwner() { return true; }\n");
  fs.rmSync(path.join(root, "features/upload/api.ts"));
  fs.writeFileSync(path.join(root, "shared/new.ts"), "export const Fresh = 1;\n");
  const again = await map.refresh({ changed: ["shared/roles.ts", "features/upload/api.ts", path.join(root, "shared/new.ts")] });
  assert.deepEqual([again.parsed, again.removed], [2, 1]);
  assert.match(map.find("isOwner"), /^isOwner {2}function {2}shared\/roles\.ts:5-5/);
  assert.match(map.find("cancelUpload"), /^(?!cancelUpload)/, "a deleted file's code is gone");

  // Touched but unchanged: re-hashed, not re-parsed.
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "shared/new.ts"), t, t);
  const touched = await map.refresh({ changed: ["shared/new.ts"] });
  assert.equal(map.file("shared/new.ts")?.m, Math.floor(fs.statSync(path.join(root, "shared/new.ts")).mtimeMs));
  assert.equal(touched.parsed, 1);

  assert.ok(!fs.existsSync(path.join(root, ".crosstalk")), "nothing written into the repo");
  assert.ok(storeDir(root).startsWith(process.env.CROSSTALK_HOME!));
  assert.match(folderId(root), /^crosstalk-map-repo-\w+-[0-9a-f]{10}$/);
});

test("modules, conventions and the docs check: computed from the map, the same every run", async () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
    "README.md": [
      "Run `npm run dev`, or `npm run storybook`.",
      "The tray is `features/upload/TransferTray.tsx`; the old one was `features/upload/OldTray.tsx`.",
      "The API lives in `backend/app/main.py` (another repo).",
      "Hooks: `useEditRights` and `useGoneHook()`. The browser's `DecompressionStream` is fine.",
      "```",
      "`features/upload/InFence.tsx` is in a code block",
      "```",
    ].join("\n"),
    "src/lib/format.ts": "export function formatBytes() {}\nexport function formatDate() {}\n",
    "src/lib/money.ts": 'import { formatBytes } from "./format";\nexport const price = () => formatBytes();\n',
    "src/lib/time.ts": 'import { formatDate } from "./format";\nexport const ago = () => formatDate();\n',
    "src/lib/ids.ts": "export const newId = () => 1;\n",
    "features/upload/TransferTray.tsx": 'import { price } from "../../src/lib/money";\nexport function TransferTray() { return price(); }\n',
    "features/upload/UploadRow.tsx": 'import { ago } from "../../src/lib/time";\nexport function UploadRow() { return ago(); }\n',
    "features/upload/UploadBadge.tsx": "export function UploadBadge() { return null; }\n",
    "features/upload/hooks/useUploads.ts": "export function useUploads() {}\n",
    "features/upload/hooks/useTray.ts": "export function useTray() {}\n",
    "features/upload/hooks/useEditRights.ts": "export function useEditRights() {}\n",
    "features/upload/upload-store.ts": 'import { newId } from "../../src/lib/ids";\nexport const store = newId();\n',
    "tests/a.test.ts": "x();\n",
    "tests/b.test.ts": "x();\n",
    "tests/c.test.ts": "x();\n",
  };
  const root = project(files);
  fs.mkdirSync(path.join(root, "features/upload/old"), { recursive: true });
  const map = new CodeMap(root);
  await map.refresh({ full: true });

  const mods = map.modules();
  assert.deepEqual(mods.map((m) => m.id).sort(), ["features/upload", "src/lib"]);
  const lib = mods.find((m) => m.id === "src/lib")!;
  assert.equal(mods[0].id, "src/lib", "the most depended-on part comes first");
  assert.equal(lib.files.length, 4);
  assert.deepEqual(mods.find((m) => m.id === "features/upload")!.dependsOn, ["src/lib"]);
  assert.deepEqual(map.modules().map((m) => m.id), mods.map((m) => m.id), "same answer every run");

  const conv = map.conventions();
  assert.ok(conv.some((c) => c.topic === "hooks" && c.rule === "live in a hooks/ folder" && c.share === 1));
  assert.ok(conv.some((c) => c.topic === "tests" && c.rule === "in a top-level tests/ folder"));
  assert.ok(conv.some((c) => c.topic === "component files" && c.rule === "named in PascalCase"));

  const stale = map.staleDocs().map((d) => `${d.line}:${d.kind}:${d.missing}`);
  assert.deepEqual(stale, ["1:script:npm run storybook", "2:file:features/upload/OldTray.tsx", "4:symbol:useGoneHook()"], "not the other repo's path, not a browser API, not inside a code block");
  assert.match(map.overview(), /docs out of date: 3 lines name things that are gone, e\.g\. README\.md:1 \(npm run storybook\)/);
  assert.match(map.outline("features/upload"), /^features\/upload\/ {2}7 files\nuses: src\/lib\nconventions: .*hooks: live in a hooks\/ folder/);
});

test("unused code: nothing imports it, nothing names it; used only in its own file is told apart; entry points never listed", async () => {
  const root = project({
    "lib/a.ts": 'export function used() {}\nexport function unused() {}\nexport const LOCAL = 1;\nexport const total = LOCAL + 1;\nexport function byName() {}\n',
    "lib/b.ts": 'import { used, total } from "./a";\nused(); total;\nconst registry = { name: "byName" };\nexport default registry;\n',
    "lib/orphan.ts": "export function lonely() {}\n",
    "app/settings/page.tsx": "export default function Page() { return null; }\nexport const metadata = {};\n",
    "proxy.ts": "export function proxy() {}\n",
    "lib/a.test.ts": 'import { unused } from "./a";\nunused();\n',
  });
  const map = new CodeMap(root);
  await map.refresh({ full: true });
  const u = map.unused();
  assert.deepEqual(u.files, ["lib/orphan.ts", "lib/b.ts"].sort(), "b.ts is imported by nothing; page.tsx and proxy.ts are entry points");
  assert.deepEqual(u.localOnly.map((e) => e.decl.n), ["LOCAL"]);
  assert.deepEqual(u.exports.map((e) => e.decl.n), [], "unused() is used by a test file; byName is named in a string");
  assert.match(map.unusedText(), /files nothing imports \(2\)/);
});

const builtTools = path.join(__dirname, "..", "dist", "crosstalk-mcp.js");
test("any agent gets the map through Crosstalk's MCP tools", { skip: !fs.existsSync(builtTools) && "run npm run build first" }, async () => {
  const root = project(APP);
  const child = spawn(process.execPath, [builtTools], { env: { ...process.env, CROSSTALK_ROOT: root }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
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
    const list = (await call("tools/list", {})).result.tools as { name: string }[];
    assert.ok(list.some((t) => t.name === "crosstalk_map"));
    const text = async (name: string, args: unknown) => (await call("tools/call", { name, arguments: args })).result.content[0].text as string;
    assert.match(await text("crosstalk_map", { find: "edit rights hook" }), /^useEditRights {2}hook/);
    assert.match(await text("crosstalk_map", { graph: "charge" }), /used by 1:\n {2}charge_invoice {2}backend\/app\/routes\.py/);
    assert.match(await text("crosstalk_map", { outline: "backend/app" }), /^backend\/app\/ {2}4 files/);
    assert.match(await text("crosstalk_map", {}), /files \(.*\), \d+ declarations/);
    fs.writeFileSync(path.join(root, "shared/later.ts"), "export function addedLater() {}\n");
    await new Promise((r) => setTimeout(r, 1600));
    assert.match(await text("crosstalk_map", { find: "addedLater" }), /^addedLater {2}function/, "a file added while the server runs is found on the next call");
  } finally {
    child.kill();
  }
});
